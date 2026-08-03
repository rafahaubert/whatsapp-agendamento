/**
 * Regras de negócio de agendamento. Puras: dependem só do Prisma e do tenant,
 * não sabem nada de WhatsApp nem de IA. São expostas ao Claude como ferramentas
 * (ver src/ai/tools.ts) e podem ser testadas isoladamente.
 *
 * Toda query filtra por tenantId (regra de ouro multi-tenant).
 */
import { DateTime } from "luxon";
import { prisma } from "../db/client.js";
import { SlotStatus, AppointmentStatus, PaymentType } from "../shared/enums.js";
import { formatDateTime, parseDataHoraLocal } from "../shared/datetime.js";
import {
  agendaDoProfissional,
  avisoPeriodoVazio,
  escolherHorarios,
  faixaDoPeriodo,
  periodosGeraveis,
  resolverDia,
  resumoAgenda,
  umPorHorario,
  type CausaVazio,
  type Periodo,
} from "./horarios.js";
import { normalizeCpf, isValidCpf } from "../shared/cpf.js";
import { casarNome } from "../shared/nomes.js";
import { logger } from "../shared/logger.js";
import {
  isGoogleConfigured,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../integrations/googleCalendar.js";
import { sendWhatsAppTemplate } from "../channels/whatsapp/client.js";
import { ConflitoAgendamento, transacaoSerializavel } from "./transacao.js";
import type { ResolvedTenant } from "../db/tenantRepository.js";

// Regras puras de horário: definidas em ./horarios.ts, re-exportadas aqui
// porque este módulo é a porta de entrada do domínio de agendamento.
export { resumoAgenda, umPorHorario };

// ---------- Catálogo ----------
export async function listSpecialties(tenantId: string) {
  return prisma.specialty.findMany({
    where: { tenantId, isActive: true },
    orderBy: { name: "asc" },
    select: { name: true, description: true, priceParticular: true },
  });
}

export async function listUnits(tenantId: string) {
  return prisma.unit.findMany({
    where: { tenantId, isActive: true },
    orderBy: { name: "asc" },
    select: { name: true, address: true },
  });
}

export async function listInsurers(tenantId: string) {
  const insurers = await prisma.insurer.findMany({
    where: { tenantId, isActive: true },
    include: { plans: { where: { isActive: true }, select: { name: true } } },
    orderBy: { name: "asc" },
  });
  const convenios = insurers.map((i) => ({ convenio: i.name, planos: i.plans.map((p) => p.name) }));

  // Lista vazia sem explicação levava o agente a insistir em convênio; o aviso
  // fecha essa porta.
  if (convenios.length === 0) {
    return {
      convenios,
      aviso:
        "A clínica NÃO tem convênios cadastrados: o atendimento é particular. Não pergunte nem fale sobre convênio.",
    };
  }
  return { convenios };
}

// ---------- Médicos e suas agendas ----------
/** Médicos da clínica com especialidades, unidades e horário de atendimento. */
export async function listDoctors(tenant: ResolvedTenant, especialidade?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { tenantId: tenant.id, isActive: true };
  if (especialidade) {
    const spec = await resolveSpecialty(tenant.id, especialidade);
    if (!spec) return { erro: `Especialidade "${especialidade}" não encontrada.` };
    where.specialties = { some: { id: spec.id } };
  }

  const doctors = await prisma.doctor.findMany({
    where,
    include: { specialties: true, units: true },
    orderBy: { name: "asc" },
  });

  return {
    medicos: doctors.map((d) => {
      const { days, propria } = agendaDoProfissional(d.workingHours, tenant.config.businessHours.days);
      return {
        nome: d.name,
        especialidades: d.specialties.map((s) => s.name),
        unidades: d.units.map((u) => u.name),
        atende: resumoAgenda(days),
        agendaPropria: propria,
      };
    }),
  };
}

// ---------- Paciente ----------
export async function findOrCreatePatient(
  tenantId: string,
  data: { nome: string; cpf: string; phone: string },
) {
  const cpf = normalizeCpf(data.cpf);
  if (!isValidCpf(cpf)) return { erro: "CPF inválido. Confira os números e tente de novo." };

  const existing = await prisma.patient.findUnique({
    where: { tenantId_cpf: { tenantId, cpf } },
  });
  if (existing) {
    const updated = await prisma.patient.update({
      where: { id: existing.id },
      data: { phone: data.phone, name: data.nome },
    });
    return { patientId: updated.id, nome: updated.name, novo: false };
  }
  const created = await prisma.patient.create({
    data: { tenantId, name: data.nome, cpf, phone: data.phone },
  });
  return { patientId: created.id, nome: created.name, novo: true };
}

/**
 * O mesmo número escrito de formas diferentes. O webhook da Meta entrega
 * "5511999999999"; o cadastro feito pelo painel costuma vir com "+" e
 * pontuação. Sem isto o paciente do painel não é reconhecido no WhatsApp.
 */
function variantesTelefone(phone: string): string[] {
  const digitos = phone.replace(/\D/g, "");
  if (!digitos) return [];
  return [...new Set([phone, digitos, `+${digitos}`])];
}

/**
 * Pacientes já cadastrados NESTE telefone, do mais recente para o mais antigo.
 *
 * O número já foi provado pelo WhatsApp, então ele vale como identificação —
 * é o que dispensa pedir nome e CPF a quem já é da casa. Vem mais de um quando
 * o telefone é da família (mãe agendando para os filhos); aí quem escolhe é o
 * paciente, não o agente.
 */
export async function pacientesDoTelefone(tenantId: string, phone: string) {
  const variantes = variantesTelefone(phone ?? "");
  if (!variantes.length) return [];

  return prisma.patient.findMany({
    where: { tenantId, phone: { in: variantes } },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, name: true },
  });
}

/**
 * Identifica o paciente da conversa.
 *
 * O CPF só é obrigatório para quem AINDA não tem cadastro neste telefone:
 * para quem já tem, o número mais o nome bastam. Pedir CPF de novo a cada
 * conversa é atrito puro — o dado já está no banco, e o WhatsApp já provou
 * de que número a mensagem veio.
 */
export async function identificarPaciente(
  tenantId: string,
  data: { nome: string; cpf?: string | null; phone: string },
) {
  if (data.cpf) {
    return findOrCreatePatient(tenantId, { nome: data.nome, cpf: data.cpf, phone: data.phone });
  }

  const cadastrados = await pacientesDoTelefone(tenantId, data.phone);
  const encontrado = casarNome(cadastrados, data.nome ?? "");
  if (encontrado) return { patientId: encontrado.id, nome: encontrado.name, novo: false };

  return {
    erro: cadastrados.length
      ? `Não há cadastro de "${data.nome}" neste telefone. Peça o CPF para cadastrar e chame identificar_paciente de novo com nome e cpf.`
      : "Este telefone ainda não tem cadastro. Peça o nome completo E o CPF, e chame identificar_paciente com os dois.",
  };
}

// ---------- Resolvers case-insensitive (portáveis SQLite/Postgres) ----------
async function resolveSpecialty(tenantId: string, name: string) {
  const all = await prisma.specialty.findMany({ where: { tenantId, isActive: true } });
  const n = name.trim().toLowerCase();
  return all.find((s) => s.name.toLowerCase() === n) ?? all.find((s) => s.name.toLowerCase().includes(n));
}

async function resolveUnit(tenantId: string, name: string) {
  const all = await prisma.unit.findMany({ where: { tenantId, isActive: true } });
  const n = name.trim().toLowerCase();
  return all.find((u) => u.name.toLowerCase() === n) ?? all.find((u) => u.name.toLowerCase().includes(n));
}

async function resolveDoctor(tenantId: string, name: string) {
  const all = await prisma.doctor.findMany({ where: { tenantId, isActive: true } });
  const n = name.trim().toLowerCase().replace(/^(dr|dra)\.?\s+/, "");
  return (
    all.find((d) => d.name.toLowerCase() === n) ??
    all.find((d) => d.name.toLowerCase().includes(n)) ??
    all.find((d) => n.includes(d.name.toLowerCase().replace(/^(dr|dra)\.?\s+/, "")))
  );
}

async function resolveHealthPlan(tenantId: string, name: string) {
  const all = await prisma.healthPlan.findMany({ where: { tenantId, isActive: true } });
  const n = name.trim().toLowerCase();
  return all.find((p) => p.name.toLowerCase() === n) ?? all.find((p) => p.name.toLowerCase().includes(n));
}

/**
 * Os períodos que a agenda REALMENTE gera, somando a agenda de cada
 * profissional (a própria, quando ele tem).
 *
 * O horário de funcionamento é só o que a clínica ANUNCIA. Quem decide quais
 * horários passam a existir é a agenda de cada profissional — e era essa
 * diferença que fazia o assistente perguntar "prefere manhã ou tarde?" para
 * depois descobrir que tarde não existe.
 */
export async function periodosReaisDaAgenda(tenant: ResolvedTenant): Promise<Periodo[]> {
  const doctors = await prisma.doctor.findMany({
    where: { tenantId: tenant.id, isActive: true },
    select: { workingHours: true },
  });
  return periodosGeraveis(
    doctors.map((d) => agendaDoProfissional(d.workingHours, tenant.config.businessHours.days).days),
    tenant.config.booking.slotDurationMinutes,
  );
}

// ---------- Horários ----------
export async function listAvailableSlots(
  tenant: ResolvedTenant,
  opts: {
    especialidade: string;
    unidade?: string;
    plano?: string;
    periodo?: string;
    /** Dia pedido pelo paciente: "segunda", "amanhã", "27/07"… */
    dia?: string;
    /** Horário pedido: "16:30" (aceita o inteiro antigo por compatibilidade). */
    horaPreferida?: string | number;
    medico?: string;
    /** Vem do contexto da conversa (não do modelo): usado para continuidade. */
    pacienteId?: string;
  },
) {
  const tenantId = tenant.id;
  const specialty = await resolveSpecialty(tenantId, opts.especialidade);
  if (!specialty) return { erro: `Especialidade "${opts.especialidade}" não encontrada.` };

  const now = new Date();
  const limite = new Date(now.getTime() + tenant.config.booking.advanceBookingDays * 86_400_000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {
    tenantId,
    specialtyId: specialty.id,
    status: SlotStatus.AVAILABLE,
    startsAt: { gte: now, lte: limite },
    // Horário prometido a alguém da fila de espera fica fora da vitrine até a
    // reserva vencer — menos para o próprio convidado, que precisa vê-lo para
    // aceitar. Sem isto o convite valia nada: outro paciente levava o horário
    // antes de o convidado abrir o WhatsApp.
    OR: [
      { reservedUntil: null },
      { reservedUntil: { lte: now } },
      ...(opts.pacienteId ? [{ reservedForPatientId: opts.pacienteId }] : []),
    ],
  };

  if (opts.unidade) {
    const unit = await resolveUnit(tenantId, opts.unidade);
    if (unit) where.unitId = unit.id;
  }
  if (opts.plano) {
    const plan = await resolveHealthPlan(tenantId, opts.plano);
    if (plan) where.doctor = { healthPlans: { some: { id: plan.id } } };
  }
  if (opts.medico) {
    const doc = await resolveDoctor(tenantId, opts.medico);
    if (!doc) return { erro: `Não encontrei o(a) profissional "${opts.medico}".` };
    where.doctorId = doc.id;
  }

  // Quando o paciente pediu uma DATA, estreita a consulta nela: a janela do
  // `take` abaixo não alcançaria um dia lá na frente.
  const filtroDia = resolverDia(opts.dia, tenant.timezone, now);
  if (filtroDia?.tipo === "data") {
    const inicio = DateTime.fromObject(
      { year: filtroDia.ano, month: filtroDia.mes, day: filtroDia.dia },
      { zone: tenant.timezone },
    );
    if (inicio.isValid) {
      where.startsAt = {
        gte: new Date(Math.max(now.getTime(), inicio.toJSDate().getTime())),
        lte: new Date(Math.min(limite.getTime(), inicio.endOf("day").toJSDate().getTime())),
      };
    }
  }

  // Busca uma janela maior e deixa a seleção (período / dia / hora, tudo em
  // horário local) para a regra pura de src/domain/horarios.ts.
  const encontrados = await prisma.slot.findMany({
    where,
    orderBy: { startsAt: "asc" },
    take: 1500,
    include: { doctor: true, unit: true },
  });

  // Continuidade: se o paciente já foi atendido, preferir o mesmo profissional.
  let profissionalHabitual: string | null = null;
  if (opts.pacienteId) {
    const ultima = await prisma.appointment.findFirst({
      where: {
        tenantId,
        patientId: opts.pacienteId,
        status: { not: AppointmentStatus.CANCELLED },
      },
      orderBy: { createdAt: "desc" },
      select: { doctorId: true },
    });
    profissionalHabitual = ultima?.doctorId ?? null;
  }

  const { escolhidos, exato, diaConsiderado, aviso } = escolherHorarios(encontrados, {
    timezone: tenant.timezone,
    max: tenant.config.booking.maxOptionsOffered,
    agora: now,
    periodo: opts.periodo,
    dia: opts.dia,
    horaPreferida: opts.horaPreferida,
    profissionalHabitual,
  });

  if (escolhidos.length === 0) {
    // Vazio não diz nada à clínica nem ao paciente. Descobre a CAUSA — a agenda
    // não cobre o período, ou ele está todo reservado — antes de responder.
    const explicado = await explicarPeriodoVazio(tenant, {
      where,
      specialtyId: specialty.id,
      especialidade: specialty.name,
      periodo: opts.periodo,
      dia: opts.dia,
    });
    return { horarios: [], aviso: explicado ?? aviso };
  }

  return {
    horarios: escolhidos.map((s) => ({
      slotId: s.id,
      medico: s.doctor.name,
      unidade: s.unit.name,
      inicio: formatDateTime(s.startsAt, tenant.timezone),
    })),
    ...(diaConsiderado ? { dia: diaConsiderado } : {}),
    ...(exato === null ? {} : { exato }),
    ...(aviso ? { aviso } : {}),
  };
}

/** Nome por extenso de um dia da semana pedido pelo paciente ("sexta" → "sexta-feira"). */
const NOME_SEMANA: Record<number, string> = {
  1: "segunda-feira",
  2: "terça-feira",
  3: "quarta-feira",
  4: "quinta-feira",
  5: "sexta-feira",
  6: "sábado",
  7: "domingo",
};

/**
 * Por que a busca voltou vazia? Devolve o aviso pronto — ou null quando não há
 * período pedido (aí o aviso genérico de `escolherHorarios` já serve).
 *
 * Roda SÓ quando não sobrou nenhum horário, então as consultas extras não pesam
 * no caminho feliz.
 */
async function explicarPeriodoVazio(
  tenant: ResolvedTenant,
  ctx: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: any;
    specialtyId: string;
    especialidade: string;
    periodo?: string;
    dia?: string;
  },
): Promise<string | null> {
  const faixa = faixaDoPeriodo(ctx.periodo);
  if (!faixa) return null;
  // Pela faixa, não pelo texto: o modelo pode mandar "manhã" com acento, e
  // faixaDoPeriodo já normalizou para chegar até aqui.
  const periodo = periodoDaFaixa(faixa);

  // Os profissionais que a busca alcançou — mesmos filtros de unidade, plano e
  // profissional aplicados aos horários.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtros: any = {
    tenantId: tenant.id,
    isActive: true,
    specialties: { some: { id: ctx.specialtyId } },
  };
  if (ctx.where.doctorId) filtros.id = ctx.where.doctorId;
  if (ctx.where.unitId) filtros.units = { some: { id: ctx.where.unitId } };
  if (ctx.where.doctor?.healthPlans) filtros.healthPlans = ctx.where.doctor.healthPlans;

  const doctors = await prisma.doctor.findMany({
    where: filtros,
    select: { name: true, workingHours: true },
  });

  const filtro = resolverDia(ctx.dia, tenant.timezone, new Date());
  const causa = await descobrirCausa(tenant, ctx, doctors, faixa, filtro);

  logger.warn(
    {
      tenant: tenant.slug,
      especialidade: ctx.especialidade,
      periodo,
      causa: causa.tipo,
      profissionais: doctors.map((d) => d.name),
    },
    "busca de horários voltou vazia",
  );

  // "Não foi gerado" não muda o que o paciente ouve, e o aviso de
  // escolherHorarios é mais preciso sobre o dia — fica com ele. A causa já foi
  // para o log e aparece no diagnóstico da agenda, no painel.
  if (causa.tipo === "sem-horario") return null;

  const diaTexto = filtro?.tipo === "semana" ? NOME_SEMANA[filtro.weekday] ?? null : null;

  return avisoPeriodoVazio({
    periodo,
    especialidade: ctx.especialidade,
    causa,
    dia: diaTexto,
    janelaDias: tenant.config.booking.advanceBookingDays,
  });
}

/** Distingue "a agenda não tem esse período" de "esse período está todo reservado". */
async function descobrirCausa(
  tenant: ResolvedTenant,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { where: any },
  doctors: { name: string; workingHours: string | null }[],
  faixa: [number, number],
  filtroDia: ReturnType<typeof resolverDia>,
): Promise<CausaVazio> {
  if (doctors.length === 0) return { tipo: "sem-profissional" };

  const agendas = doctors.map(
    (d) => agendaDoProfissional(d.workingHours, tenant.config.businessHours.days).days,
  );
  const reais = periodosGeraveis(agendas, tenant.config.booking.slotDurationMinutes);
  if (!reais.includes(periodoDaFaixa(faixa))) {
    return { tipo: "fora-da-agenda", periodosReais: reais };
  }

  // A agenda prevê o período: ou está todo reservado, ou não chegou a ser gerado.
  // O `where` só é estreitado numa DATA, então o dia da semana é filtrado aqui.
  const reservados = await prisma.slot.findMany({
    where: { ...ctx.where, status: { not: SlotStatus.AVAILABLE } },
    select: { startsAt: true },
    take: 2000,
  });
  const noPeriodo = reservados.some((s) => {
    const local = DateTime.fromJSDate(s.startsAt).setZone(tenant.timezone);
    if (filtroDia?.tipo === "semana" && local.weekday !== filtroDia.weekday) return false;
    return local.hour >= faixa[0] && local.hour < faixa[1];
  });

  return noPeriodo ? { tipo: "tudo-reservado" } : { tipo: "sem-horario" };
}

/** O período dono de uma faixa de horas (a faixa vem de faixaDoPeriodo). */
function periodoDaFaixa(faixa: [number, number]): Periodo {
  if (faixa[1] <= 12) return "manha";
  return faixa[0] >= 18 ? "noite" : "tarde";
}

// ---------- Agendar ----------
export async function bookAppointment(
  tenant: ResolvedTenant,
  patientId: string,
  slotId: string,
  paymentType: string,
  plano?: string,
) {
  const tenantId = tenant.id;

  const outcome = await transacaoSerializavel("bookAppointment", async (tx) => {
    const slot = await tx.slot.findFirst({
      where: { id: slotId, tenantId },
      include: { doctor: true, unit: true, specialty: true },
    });
    if (!slot) throw new ConflitoAgendamento("Horário não encontrado.");
    if (slot.status !== SlotStatus.AVAILABLE) {
      throw new ConflitoAgendamento("Esse horário acabou de ser reservado. Escolha outro.");
    }

    // Reserva da fila de espera: dentro da janela, o horário é de quem foi
    // convidado. A checagem mora DENTRO da transação porque a vitrine
    // (listAvailableSlots) filtra por leitura e o paciente pode chegar aqui com
    // um slotId antigo, de antes de a reserva existir.
    if (
      slot.reservedUntil &&
      slot.reservedUntil > new Date() &&
      slot.reservedForPatientId !== patientId
    ) {
      throw new ConflitoAgendamento(
        "Esse horário está reservado para outro paciente por alguns minutos. Escolha outro.",
      );
    }

    // Um slot só comporta um agendamento (índice único em slotId). Se sobrou
    // um agendamento cancelado preso a ele (dado antigo), avisa em vez de
    // estourar P2002 no meio da conversa.
    const jaUsado = await tx.appointment.findUnique({
      where: { slotId: slot.id },
      select: { id: true },
    });
    if (jaUsado) {
      throw new ConflitoAgendamento("Esse horário acabou de ser reservado. Escolha outro.");
    }

    // O gerador cria um slot por unidade × especialidade do profissional: sem
    // esta checagem dois pacientes cairiam no mesmo profissional e horário.
    const conflito = await tx.appointment.findFirst({
      where: {
        tenantId,
        status: { not: AppointmentStatus.CANCELLED },
        slot: {
          doctorId: slot.doctorId,
          startsAt: { lt: slot.endsAt },
          endsAt: { gt: slot.startsAt },
        },
      },
      select: { id: true },
    });
    if (conflito) {
      throw new ConflitoAgendamento("O profissional já tem consulta nesse horário. Escolha outro.");
    }

    // O paciente é uma pessoa só: não pode estar em duas cadeiras ao mesmo
    // tempo. A trava acima não pega isto — cada profissional tem o SEU slot,
    // então o mesmo paciente às 13:00 com o Dr. A e com o Dr. B passava direto.
    const conflitoPaciente = await tx.appointment.findFirst({
      where: {
        tenantId,
        patientId,
        status: { not: AppointmentStatus.CANCELLED },
        slot: { startsAt: { lt: slot.endsAt }, endsAt: { gt: slot.startsAt } },
      },
      select: { id: true },
    });
    if (conflitoPaciente) {
      throw new ConflitoAgendamento("Este paciente já tem uma consulta nesse horário. Escolha outro.");
    }

    let healthPlanId: string | null = null;
    let pType: string = PaymentType.PARTICULAR;
    if (paymentType === PaymentType.HEALTH_PLAN && plano) {
      const plan = await resolveHealthPlan(tenantId, plano);
      if (plan) {
        healthPlanId = plan.id;
        pType = PaymentType.HEALTH_PLAN;
      }
    }

    const appt = await tx.appointment.create({
      data: {
        tenantId,
        unitId: slot.unitId,
        patientId,
        doctorId: slot.doctorId,
        specialtyId: slot.specialtyId,
        slotId: slot.id,
        healthPlanId,
        paymentType: pType,
        status: AppointmentStatus.SCHEDULED,
      },
    });
    // Lock otimista: só reserva se o slot AINDA estiver livre. O `update` simples
    // gravava BOOKED por cima sem olhar o estado, então dois cliques quase
    // simultâneos no mesmo horário viravam dois agendamentos. Com o `status` no
    // WHERE, o Postgres serializa as duas na linha do slot e a segunda enxerga
    // count = 0.
    const reservado = await tx.slot.updateMany({
      where: { id: slot.id, status: SlotStatus.AVAILABLE },
      // A reserva da fila de espera some junto: cumpriu o papel dela.
      data: { status: SlotStatus.BOOKED, reservedUntil: null, reservedForPatientId: null },
    });
    if (reservado.count === 0) {
      throw new ConflitoAgendamento("Esse horário acabou de ser reservado. Escolha outro.");
    }
    return { appt, slot };
  });

  if ("erro" in outcome) return outcome;
  const { appt, slot } = outcome;

  // Fecha a inscrição na fila de espera: quem conseguiu a consulta não está mais
  // esperando. O status DONE existia no schema desde o começo e nunca era
  // atribuído — o paciente atendido continuava na fila para sempre.
  await encerrarFilaEspera(tenant.id, patientId, slot.specialtyId).catch((err) =>
    logger.error({ err, patientId }, "falha ao encerrar a inscrição na fila de espera"),
  );

  // Google Calendar (one-way, best-effort, FORA da transação).
  const calendarId = slot.doctor.googleCalendarId;
  if (calendarId && isGoogleConfigured()) {
    try {
      const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { name: true } });
      const eventId = await createEvent(calendarId, {
        summary: `Consulta: ${patient?.name ?? "Paciente"} (${slot.specialty.name})`,
        description: `Dentista: ${slot.doctor.name}\nUnidade: ${slot.unit.name}`,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        timeZone: tenant.timezone,
      });
      if (eventId) {
        await prisma.appointment.update({ where: { id: appt.id }, data: { googleEventId: eventId } });
      }
    } catch (err) {
      logger.error({ err, appointmentId: appt.id }, "falha ao criar evento no Google Calendar");
    }
  }

  return {
    appointmentId: appt.id,
    medico: slot.doctor.name,
    unidade: slot.unit.name,
    especialidade: slot.specialty.name,
    inicio: formatDateTime(slot.startsAt, tenant.timezone),
    status: "AGENDADO",
  };
}

// ---------- Consultar / Cancelar / Remarcar ----------
export async function listPatientAppointments(tenant: ResolvedTenant, patientId: string) {
  const now = new Date();
  const appts = await prisma.appointment.findMany({
    where: {
      tenantId: tenant.id,
      patientId,
      status: {
        in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED, AppointmentStatus.RESCHEDULED],
      },
      slot: { startsAt: { gte: now } },
    },
    include: { doctor: true, unit: true, specialty: true, slot: true },
    orderBy: { slot: { startsAt: "asc" } },
  });

  return appts.map((a) => ({
    appointmentId: a.id,
    especialidade: a.specialty.name,
    medico: a.doctor.name,
    unidade: a.unit.name,
    inicio: formatDateTime(a.slot.startsAt, tenant.timezone),
  }));
}

export async function cancelAppointment(tenant: ResolvedTenant, appointmentId: string) {
  if (!tenant.config.booking.allowCancellation) {
    return { erro: "Cancelamento não permitido pelo assistente. Oriente a ligar para a recepção." };
  }
  const outcome = await transacaoSerializavel("cancelAppointment", async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, tenantId: tenant.id },
      include: { doctor: { select: { googleCalendarId: true } }, slot: true },
    });
    if (!appt) throw new ConflitoAgendamento("Agendamento não encontrado.");
    if (appt.status === AppointmentStatus.CANCELLED) {
      throw new ConflitoAgendamento("Esse agendamento já está cancelado.");
    }

    // Cancela condicionalmente: só o primeiro dos dois cliques passa. Sem o
    // status no WHERE, dois cancelamentos simultâneos passavam os dois pela
    // checagem acima, criavam DOIS slots livres para o mesmo horário e avisavam
    // a fila de espera duas vezes — duas mensagens de template pagas, e dois
    // pacientes convidados para uma vaga só.
    const cancelado = await tx.appointment.updateMany({
      where: { id: appt.id, status: { not: AppointmentStatus.CANCELLED } },
      data: { status: AppointmentStatus.CANCELLED },
    });
    if (cancelado.count === 0) {
      throw new ConflitoAgendamento("Esse agendamento já está cancelado.");
    }

    // O slot NÃO volta a ficar livre: ele continua sendo o registro histórico
    // da consulta cancelada (todo o painel lê a data em appointment.slot) e a
    // FK/índice único em slotId o mantêm preso ao agendamento — reaproveitá-lo
    // quebrava tanto a renovação da agenda quanto um novo agendamento no mesmo
    // horário. O horário volta para a agenda como um slot NOVO, livre.
    const livre = await tx.slot.create({
      data: {
        tenantId: tenant.id,
        unitId: appt.slot.unitId,
        doctorId: appt.slot.doctorId,
        specialtyId: appt.slot.specialtyId,
        startsAt: appt.slot.startsAt,
        endsAt: appt.slot.endsAt,
        status: SlotStatus.AVAILABLE,
      },
    });
    return { appt, slotLivreId: livre.id };
  });

  if ("erro" in outcome) return outcome;
  const { appt, slotLivreId } = outcome;

  if (appt.googleEventId && appt.doctor.googleCalendarId && isGoogleConfigured()) {
    try {
      await deleteEvent(appt.doctor.googleCalendarId, appt.googleEventId);
    } catch (err) {
      logger.error({ err, appointmentId: appt.id }, "falha ao remover evento do Google Calendar");
    }
  }

  // O horário voltou a ficar livre: avisa quem está na fila de espera.
  try {
    await notificarFilaEspera(tenant, slotLivreId);
  } catch (err) {
    logger.error({ err, appointmentId: appt.id }, "falha ao avisar a fila de espera");
  }

  return { status: "CANCELADO", appointmentId: appt.id };
}

export async function rescheduleAppointment(
  tenant: ResolvedTenant,
  appointmentId: string,
  novoSlotId: string,
) {
  if (!tenant.config.booking.allowReschedule) {
    return { erro: "Remarcação não permitida pelo assistente." };
  }
  return doReschedule(tenant, appointmentId, novoSlotId);
}

/** Núcleo da remarcação (sem checar a regra do assistente) — usado pelo agente e pelo painel. */
async function doReschedule(tenant: ResolvedTenant, appointmentId: string, novoSlotId: string) {
  const outcome = await transacaoSerializavel("doReschedule", async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, tenantId: tenant.id },
      include: { doctor: { select: { googleCalendarId: true } } },
    });
    if (!appt) throw new ConflitoAgendamento("Agendamento não encontrado.");

    const novo = await tx.slot.findFirst({
      where: { id: novoSlotId, tenantId: tenant.id },
      include: { doctor: true, unit: true, specialty: true },
    });
    if (!novo) throw new ConflitoAgendamento("Novo horário não encontrado.");
    if (novo.status !== SlotStatus.AVAILABLE) {
      throw new ConflitoAgendamento("Esse horário não está mais livre.");
    }
    if (novo.id === appt.slotId) {
      throw new ConflitoAgendamento("O agendamento já está nesse horário.");
    }
    // Mesma regra do agendamento: horário prometido à fila de espera é de quem
    // foi convidado enquanto a reserva durar.
    if (
      novo.reservedUntil &&
      novo.reservedUntil > new Date() &&
      novo.reservedForPatientId !== appt.patientId
    ) {
      throw new ConflitoAgendamento(
        "Esse horário está reservado para outro paciente por alguns minutos. Escolha outro.",
      );
    }

    // Mesmas travas de bookAppointment: um slot só comporta um agendamento e o
    // profissional não pode ter duas consultas ao mesmo tempo.
    const jaUsado = await tx.appointment.findUnique({
      where: { slotId: novo.id },
      select: { id: true },
    });
    if (jaUsado) throw new ConflitoAgendamento("Esse horário não está mais livre.");

    const conflito = await tx.appointment.findFirst({
      where: {
        id: { not: appt.id },
        tenantId: tenant.id,
        status: { not: AppointmentStatus.CANCELLED },
        slot: {
          doctorId: novo.doctorId,
          startsAt: { lt: novo.endsAt },
          endsAt: { gt: novo.startsAt },
        },
      },
      select: { id: true },
    });
    if (conflito) {
      throw new ConflitoAgendamento("O profissional já tem consulta nesse horário. Escolha outro.");
    }

    // Mesma regra do agendamento: o paciente não pode ficar com duas consultas
    // sobrepostas — nem remarcando por cima de outra que ele já tem.
    const conflitoPaciente = await tx.appointment.findFirst({
      where: {
        id: { not: appt.id },
        tenantId: tenant.id,
        patientId: appt.patientId,
        status: { not: AppointmentStatus.CANCELLED },
        slot: { startsAt: { lt: novo.endsAt }, endsAt: { gt: novo.startsAt } },
      },
      select: { id: true },
    });
    if (conflitoPaciente) {
      throw new ConflitoAgendamento("Este paciente já tem uma consulta nesse horário. Escolha outro.");
    }

    // O agendamento sai deste slot, então ele fica solto e pode voltar à agenda.
    await tx.slot.update({
      where: { id: appt.slotId },
      data: { status: SlotStatus.AVAILABLE, reservedUntil: null, reservedForPatientId: null },
    });
    // Mesmo lock otimista do agendamento: só toma o slot novo se ninguém tomou antes.
    const reservado = await tx.slot.updateMany({
      where: { id: novo.id, status: SlotStatus.AVAILABLE },
      data: { status: SlotStatus.BOOKED, reservedUntil: null, reservedForPatientId: null },
    });
    if (reservado.count === 0) {
      throw new ConflitoAgendamento("Esse horário não está mais livre.");
    }
    const updated = await tx.appointment.update({
      where: { id: appt.id },
      data: {
        slotId: novo.id,
        doctorId: novo.doctorId,
        unitId: novo.unitId,
        specialtyId: novo.specialtyId,
        status: AppointmentStatus.RESCHEDULED,
      },
    });
    return { appt, novo, updated };
  });

  if ("erro" in outcome) return outcome;
  const { appt, novo, updated } = outcome;

  // Remarcar libera o horário antigo tanto quanto cancelar — e um horário nobre
  // que vaga por remarcação vale o mesmo para quem está esperando. A fila só
  // era avisada no cancelamento, então metade das vagas passava batido.
  try {
    await notificarFilaEspera(tenant, appt.slotId);
  } catch (err) {
    logger.error({ err, appointmentId: updated.id }, "falha ao avisar a fila de espera");
  }

  // Google Calendar: atualiza o evento (ou move de calendário se o dentista mudou).
  if (isGoogleConfigured()) {
    try {
      const oldCal = appt.doctor.googleCalendarId;
      const newCal = novo.doctor.googleCalendarId;
      const patient = await prisma.patient.findUnique({ where: { id: updated.patientId }, select: { name: true } });
      const ev = {
        summary: `Consulta: ${patient?.name ?? "Paciente"} (${novo.specialty.name})`,
        description: `Dentista: ${novo.doctor.name}\nUnidade: ${novo.unit.name}`,
        startsAt: novo.startsAt,
        endsAt: novo.endsAt,
        timeZone: tenant.timezone,
      };
      if (appt.googleEventId && oldCal && oldCal === newCal) {
        await updateEvent(newCal, appt.googleEventId, ev);
      } else {
        if (appt.googleEventId && oldCal) await deleteEvent(oldCal, appt.googleEventId).catch(() => {});
        const newEventId = newCal ? await createEvent(newCal, ev) : null;
        await prisma.appointment.update({ where: { id: updated.id }, data: { googleEventId: newEventId } });
      }
    } catch (err) {
      logger.error({ err, appointmentId: updated.id }, "falha ao sincronizar remarcação no Google Calendar");
    }
  }

  return {
    status: "REMARCADO",
    appointmentId: updated.id,
    medico: novo.doctor.name,
    unidade: novo.unit.name,
    inicio: formatDateTime(novo.startsAt, tenant.timezone),
  };
}

// =========================================================
// Operações administrativas (painel) — criar/mover manualmente
// =========================================================

/** Acha um slot LIVRE no horário exato ou cria um (agenda administrativa). */
async function findOrCreateSlot(
  tenantId: string,
  p: { doctorId: string; specialtyId: string; unitId: string; startsAt: Date; durationMinutes: number },
) {
  const existing = await prisma.slot.findFirst({
    where: {
      tenantId,
      doctorId: p.doctorId,
      specialtyId: p.specialtyId,
      startsAt: p.startsAt,
      status: SlotStatus.AVAILABLE,
    },
  });
  if (existing) return existing;

  return prisma.slot.create({
    data: {
      tenantId,
      unitId: p.unitId,
      doctorId: p.doctorId,
      specialtyId: p.specialtyId,
      startsAt: p.startsAt,
      endsAt: new Date(p.startsAt.getTime() + p.durationMinutes * 60_000),
      status: SlotStatus.AVAILABLE,
    },
  });
}

/** Cria um agendamento manualmente pelo painel (cria o paciente e o horário se preciso). */
export async function createManualAppointment(
  tenant: ResolvedTenant,
  p: {
    nome: string;
    cpf: string;
    telefone?: string;
    doctorId: string;
    specialtyId: string;
    unitId: string;
    startsAt: string; // ISO local vindo do formulário
    paymentType?: string;
    plano?: string;
  },
) {
  // Lido no fuso da CLÍNICA: o formulário manda "2026-07-31T14:00" sem fuso e o
  // servidor de produção roda em UTC — ver parseDataHoraLocal.
  const startsAt = parseDataHoraLocal(p.startsAt, tenant.timezone);
  if (!startsAt) return { erro: "Data/hora inválida." };

  const paciente = await findOrCreatePatient(tenant.id, {
    nome: p.nome,
    cpf: p.cpf,
    phone: p.telefone ?? "",
  });
  if ("erro" in paciente) return paciente;

  // Todos os ids vêm de formulário: confirme que pertencem A ESTA clínica.
  const [doctor, specialty, unit] = await Promise.all([
    prisma.doctor.findFirst({ where: { id: p.doctorId, tenantId: tenant.id } }),
    prisma.specialty.findFirst({ where: { id: p.specialtyId, tenantId: tenant.id } }),
    prisma.unit.findFirst({ where: { id: p.unitId, tenantId: tenant.id } }),
  ]);
  if (!doctor) return { erro: "Profissional não encontrado." };
  if (!specialty) return { erro: "Especialidade não encontrada." };
  if (!unit) return { erro: "Unidade não encontrada." };

  const slot = await findOrCreateSlot(tenant.id, {
    doctorId: p.doctorId,
    specialtyId: p.specialtyId,
    unitId: p.unitId,
    startsAt,
    durationMinutes: tenant.config.booking.slotDurationMinutes,
  });

  return bookAppointment(
    tenant,
    paciente.patientId,
    slot.id,
    p.paymentType ?? PaymentType.PARTICULAR,
    p.plano,
  );
}

/** Move um agendamento para outro horário (arrastar no calendário do painel). */
export async function moveAppointment(
  tenant: ResolvedTenant,
  appointmentId: string,
  novoInicioISO: string,
) {
  const startsAt = parseDataHoraLocal(novoInicioISO, tenant.timezone);
  if (!startsAt) return { erro: "Data/hora inválida." };

  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId: tenant.id },
  });
  if (!appt) return { erro: "Agendamento não encontrado." };

  const slot = await findOrCreateSlot(tenant.id, {
    doctorId: appt.doctorId,
    specialtyId: appt.specialtyId,
    unitId: appt.unitId,
    startsAt,
    durationMinutes: tenant.config.booking.slotDurationMinutes,
  });

  return doReschedule(tenant, appointmentId, slot.id);
}

/** Confirma a presença do paciente (resposta ao lembrete). */
export async function confirmAppointment(tenant: ResolvedTenant, appointmentId: string) {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId: tenant.id },
    include: { doctor: true, unit: true, specialty: true, slot: true },
  });
  if (!appt) return { erro: "Agendamento não encontrado." };
  if (appt.status === AppointmentStatus.CANCELLED) {
    return { erro: "Esse agendamento está cancelado." };
  }

  await prisma.appointment.update({
    where: { id: appt.id },
    data: { status: AppointmentStatus.CONFIRMED, confirmedAt: new Date() },
  });

  return {
    status: "CONFIRMADO",
    appointmentId: appt.id,
    medico: appt.doctor.name,
    unidade: appt.unit.name,
    especialidade: appt.specialty.name,
    inicio: formatDateTime(appt.slot.startsAt, tenant.timezone),
  };
}

/**
 * Registra o desfecho da consulta (base da taxa de falta).
 * `compareceu = false` grava NO_SHOW — a métrica que a clínica mais quer ver cair.
 */
export async function marcarComparecimento(
  tenant: ResolvedTenant,
  appointmentId: string,
  compareceu: boolean,
) {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId: tenant.id },
  });
  if (!appt) return { erro: "Agendamento não encontrado." };

  await prisma.appointment.update({
    where: { id: appt.id },
    data: {
      status: compareceu ? AppointmentStatus.COMPLETED : AppointmentStatus.NO_SHOW,
      // Alguém afirmou o desfecho (a recepção pelo painel ou o próprio paciente
      // pelo botão): deixa de ser presunção. Sem isto, uma consulta presumida e
      // depois corrigida continuaria contando como estimativa no painel.
      outcomeAuto: false,
    },
  });
  return { status: compareceu ? "COMPARECEU" : "FALTOU", appointmentId: appt.id };
}

// =========================================================
// Fila de espera — transforma cancelamento em receita
// =========================================================

/** Período do dia de um horário, no fuso da clínica. */
function periodoDoHorario(quando: Date, timezone: string): string {
  const h = DateTime.fromJSDate(quando).setZone(timezone).hour;
  if (h < 12) return "manha";
  if (h < 18) return "tarde";
  return "noite";
}

/** Coloca o paciente na fila de espera de uma especialidade. */
export async function entrarFilaEspera(
  tenant: ResolvedTenant,
  patientId: string,
  especialidade: string,
  periodo?: string,
) {
  const spec = await resolveSpecialty(tenant.id, especialidade);
  if (!spec) return { erro: `Especialidade "${especialidade}" não encontrada.` };

  const jaNaFila = await prisma.waitlist.findFirst({
    where: { tenantId: tenant.id, patientId, specialtyId: spec.id, status: "ACTIVE" },
  });
  if (jaNaFila) return { ok: true, jaEstava: true, especialidade: spec.name };

  await prisma.waitlist.create({
    data: {
      tenantId: tenant.id,
      patientId,
      specialtyId: spec.id,
      periodo: periodo?.trim().toLowerCase() || null,
    },
  });
  return { ok: true, jaEstava: false, especialidade: spec.name };
}

/**
 * Quanto tempo o horário fica segurado para quem foi avisado.
 *
 * Sem uma reserva, avisar o primeiro da fila era só um aviso: qualquer outro
 * paciente podia levar o horário antes de a mensagem ser lida — e o convidado
 * chegava para descobrir que já era tarde. Trinta minutos dão tempo de ver o
 * WhatsApp sem congelar a agenda para o resto do mundo.
 */
export const RESERVA_FILA_MINUTOS = 30;

/**
 * Ofertas ignoradas antes de encerrar a inscrição na fila.
 *
 * Quem não responde três convites não está esperando de verdade; mantê-lo na
 * frente da fila atrasaria todo mundo atrás.
 */
export const MAX_OFERTAS_PERDIDAS = 3;

/**
 * Avisa o próximo da fila quando um horário é liberado (cancelamento ou
 * remarcação) e SEGURA o horário para ele por alguns minutos.
 *
 * Best-effort: nunca quebra a operação que a chamou.
 */
export async function notificarFilaEspera(tenant: ResolvedTenant, slotId: string): Promise<void> {
  const template = tenant.config.waitlist?.templateName;
  if (!tenant.config.waitlist?.enabled || !template) return;

  const agora = new Date();

  const slot = await prisma.slot.findFirst({
    where: {
      id: slotId,
      tenantId: tenant.id,
      status: SlotStatus.AVAILABLE,
      // Já prometido a alguém que ainda tem tempo de responder: não oferecer de novo.
      OR: [{ reservedUntil: null }, { reservedUntil: { lte: agora } }],
    },
    include: { doctor: true, unit: true, specialty: true },
  });
  if (!slot) return;

  const periodo = periodoDoHorario(slot.startsAt, tenant.timezone);

  const candidato = await prisma.waitlist.findFirst({
    where: {
      tenantId: tenant.id,
      specialtyId: slot.specialtyId,
      status: "ACTIVE",
      ofertasPerdidas: { lt: MAX_OFERTAS_PERDIDAS },
      OR: [{ periodo: null }, { periodo }],
    },
    // Quem nunca deixou passar uma oferta vem primeiro; entre iguais, quem
    // esperou mais tempo. Sem o primeiro critério, quem ignora convites ficaria
    // eternamente na frente de quem nunca recebeu nenhum.
    orderBy: [{ ofertasPerdidas: "asc" }, { createdAt: "asc" }],
    include: { patient: true },
  });
  if (!candidato) return;

  // A reserva vem ANTES do envio: se o processo cair no meio, o pior caso é um
  // horário segurado por 30 minutos sem ninguém avisado — nunca o contrário,
  // que é o paciente correndo para um horário que outro já levou.
  const reservado = await prisma.slot.updateMany({
    where: {
      id: slot.id,
      status: SlotStatus.AVAILABLE,
      OR: [{ reservedUntil: null }, { reservedUntil: { lte: agora } }],
    },
    data: {
      reservedUntil: new Date(agora.getTime() + RESERVA_FILA_MINUTOS * 60_000),
      reservedForPatientId: candidato.patientId,
    },
  });
  // Outro ciclo do job (ou outro cancelamento) chegou primeiro nesta linha.
  if (reservado.count === 0) return;

  await prisma.waitlist.update({
    where: { id: candidato.id },
    data: { status: "NOTIFIED", notifiedAt: agora, slotId: slot.id },
  });

  try {
    await sendWhatsAppTemplate(tenant.whatsappPhoneNumberId, candidato.patient.phone, {
      name: template,
      lang: tenant.config.waitlist.templateLang || "pt_BR",
      // {{1}} paciente · {{2}} data/hora · {{3}} profissional · {{4}} unidade
      bodyParams: [
        candidato.patient.name,
        formatDateTime(slot.startsAt, tenant.timezone),
        slot.doctor.name,
        slot.unit.name,
      ],
      // O botão devolve o slotId — o motor já sabe tratar payloads "SLOT:".
      buttonPayloads: [`SLOT:${slot.id}`],
    });
  } catch (err) {
    // Envio falhou: desfaz a reserva na hora em vez de deixar o horário preso
    // meia hora por causa de um template rejeitado.
    await liberarReserva(slot.id).catch(() => undefined);
    await prisma.waitlist
      .update({ where: { id: candidato.id }, data: { status: "ACTIVE", slotId: null } })
      .catch(() => undefined);
    logger.error(
      { err, tenant: tenant.slug, slotId },
      "falha ao avisar a fila de espera — reserva desfeita",
    );
    return;
  }

  logger.info(
    { tenant: tenant.slug, pacienteId: candidato.patient.id, slotId },
    "fila de espera avisada sobre horário liberado",
  );
}

/** Solta a reserva temporária de um horário. */
async function liberarReserva(slotId: string): Promise<void> {
  await prisma.slot.updateMany({
    where: { id: slotId },
    data: { reservedUntil: null, reservedForPatientId: null },
  });
}

/**
 * Encerra a inscrição do paciente na fila daquela especialidade — ele conseguiu
 * a consulta e não está mais esperando.
 */
export async function encerrarFilaEspera(
  tenantId: string,
  patientId: string,
  specialtyId: string,
): Promise<void> {
  await prisma.waitlist.updateMany({
    where: { tenantId, patientId, specialtyId, status: { in: ["ACTIVE", "NOTIFIED"] } },
    data: { status: "DONE", slotId: null },
  });
}

/**
 * Encerra as ofertas vencidas e passa a vez ao próximo da fila.
 *
 * É o que faltava para a fila não morrer no primeiro convidado: antes, quem não
 * respondia virava NOTIFIED e ficava lá para sempre — ninguém mais era avisado
 * e o horário voltava ao balcão sem que a fila soubesse.
 */
export async function expirarOfertasFilaEspera(
  tenant: ResolvedTenant,
  agora = new Date(),
): Promise<{ reofertados: number; encerrados: number }> {
  if (!tenant.config.waitlist?.enabled) return { reofertados: 0, encerrados: 0 };

  const limite = new Date(agora.getTime() - RESERVA_FILA_MINUTOS * 60_000);

  const vencidas = await prisma.waitlist.findMany({
    where: { tenantId: tenant.id, status: "NOTIFIED", notifiedAt: { lte: limite } },
    take: 200,
  });

  let reofertados = 0;
  let encerrados = 0;

  for (const oferta of vencidas) {
    // O horário virou consulta? Então a oferta deu certo: encerra a inscrição.
    const virouConsulta = oferta.slotId
      ? await prisma.appointment.findFirst({
          where: {
            slotId: oferta.slotId,
            patientId: oferta.patientId,
            status: { not: AppointmentStatus.CANCELLED },
          },
          select: { id: true },
        })
      : null;

    if (virouConsulta) {
      await prisma.waitlist.update({
        where: { id: oferta.id },
        data: { status: "DONE", slotId: null },
      });
      encerrados++;
      continue;
    }

    const perdidas = oferta.ofertasPerdidas + 1;
    const desiste = perdidas >= MAX_OFERTAS_PERDIDAS;

    await prisma.waitlist.update({
      where: { id: oferta.id },
      data: {
        status: desiste ? "DONE" : "ACTIVE",
        ofertasPerdidas: perdidas,
        slotId: null,
      },
    });
    if (desiste) encerrados++;

    // Solta o horário e oferece ao próximo — este é o ponto todo do job.
    if (oferta.slotId) {
      await liberarReserva(oferta.slotId);
      await notificarFilaEspera(tenant, oferta.slotId).catch((err) =>
        logger.error({ err, slotId: oferta.slotId }, "falha ao reofertar horário da fila"),
      );
      reofertados++;
    }
  }

  if (reofertados || encerrados) {
    logger.info({ tenant: tenant.slug, reofertados, encerrados }, "fila de espera reprocessada");
  }
  return { reofertados, encerrados };
}
