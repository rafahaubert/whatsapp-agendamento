/**
 * Operações de administração sobre clínicas e catálogo. Camada fina sobre o
 * Prisma, usada pelas rotas do painel. Tudo escopado por tenantId.
 */
import { prisma } from "../db/client.js";
import { regenerateSlots } from "../db/seed.js";
import { AppointmentStatus, statusUI } from "../shared/enums.js";
import { formatDateTime, formatarHoraCurta, formatarDia } from "../shared/datetime.js";
import type { TenantConfig } from "../config/types.js";

/** Config padrão ao criar uma clínica nova. */
export function defaultConfig(name: string): TenantConfig {
  const dia = { open: "08:00", close: "18:00" };
  return {
    branding: {
      clinicName: name,
      greetingMessage: `Olá! 👋 Sou o assistente virtual da ${name}. Posso te ajudar a agendar uma consulta. Qual é o seu nome completo?`,
      fallbackMessage: "Desculpe, não entendi. Digite *atendente* para falar com a recepção.",
      closingMessage: "Prontinho! Seu agendamento está confirmado. ✅ Até breve!",
    },
    businessHours: {
      timezone: "America/Sao_Paulo",
      days: { 0: null, 1: dia, 2: dia, 3: dia, 4: dia, 5: dia, 6: { open: "08:00", close: "12:00" } },
    },
    booking: {
      slotDurationMinutes: 30,
      maxOptionsOffered: 3,
      advanceBookingDays: 30,
      allowCancellation: true,
      allowReschedule: true,
      askInsurance: true,
      acceptParticular: true,
    },
    ai: {
      model: "claude-haiku-4-5",
      persona:
        "Você é um atendente cordial, objetivo e acolhedor de uma clínica médica no Brasil. Use português do Brasil, seja breve e evite jargões.",
    },
    debounceSeconds: 8,
  };
}

export async function listTenants() {
  return prisma.tenant.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      whatsappPhoneNumberId: true,
      isActive: true,
      _count: { select: { doctors: true, slots: true } },
    },
  });
}

export async function getTenant(id: string) {
  const t = await prisma.tenant.findUnique({
    where: { id },
    include: {
      units: { orderBy: { name: "asc" } },
      specialties: { orderBy: { name: "asc" } },
      insurers: { orderBy: { name: "asc" }, include: { plans: { orderBy: { name: "asc" } } } },
      doctors: {
        orderBy: { name: "asc" },
        include: { specialties: true, units: true, healthPlans: true },
      },
    },
  });
  if (!t) return null;
  return { ...t, parsedConfig: JSON.parse(t.config) as TenantConfig };
}

export async function createTenant(data: {
  slug: string;
  name: string;
  whatsappPhoneNumberId: string;
  timezone: string;
}) {
  return prisma.tenant.create({
    data: {
      slug: data.slug,
      name: data.name,
      whatsappPhoneNumberId: data.whatsappPhoneNumberId,
      timezone: data.timezone,
      config: JSON.stringify(defaultConfig(data.name)),
    },
  });
}

export async function updateTenant(
  id: string,
  data: { name: string; whatsappPhoneNumberId: string; timezone: string; isActive: boolean; config: TenantConfig },
) {
  return prisma.tenant.update({
    where: { id },
    data: {
      name: data.name,
      whatsappPhoneNumberId: data.whatsappPhoneNumberId,
      timezone: data.timezone,
      isActive: data.isActive,
      config: JSON.stringify(data.config),
    },
  });
}

// ---------- Catálogo ----------
export async function addUnit(tenantId: string, d: { name: string; address?: string; phone?: string }) {
  await prisma.unit.create({
    data: { tenantId, name: d.name, address: d.address || null, phone: d.phone || null },
  });
}

export async function addSpecialty(tenantId: string, name: string, priceParticular?: string) {
  await prisma.specialty.create({
    data: { tenantId, name, priceParticular: priceParticular?.trim() || null },
  });
}

export async function updateSpecialtyPrice(tenantId: string, id: string, priceParticular?: string) {
  await prisma.specialty.updateMany({
    where: { id, tenantId },
    data: { priceParticular: priceParticular?.trim() || null },
  });
}

export async function addInsurer(tenantId: string, d: { name: string; code?: string }) {
  await prisma.insurer.create({ data: { tenantId, name: d.name, code: d.code || null } });
}

export async function addPlan(tenantId: string, insurerId: string, name: string) {
  // O convênio precisa ser DESTA clínica (o id vem de um formulário).
  const insurer = await prisma.insurer.findFirst({ where: { id: insurerId, tenantId } });
  if (!insurer) return;
  await prisma.healthPlan.create({ data: { tenantId, insurerId: insurer.id, name } });
}

export async function addDoctor(
  tenantId: string,
  d: { name: string; crm?: string; specialtyIds: string[]; unitIds: string[]; planIds: string[] },
) {
  // Os ids vêm de um formulário: só conecta o que pertence A ESTA clínica.
  // Sem isso, um id forjado ligaria o profissional a uma unidade de outra
  // clínica — e o nome/endereço dela vazaria para os pacientes.
  const [specialties, units, plans] = await Promise.all([
    prisma.specialty.findMany({ where: { tenantId, id: { in: d.specialtyIds } }, select: { id: true } }),
    prisma.unit.findMany({ where: { tenantId, id: { in: d.unitIds } }, select: { id: true } }),
    prisma.healthPlan.findMany({ where: { tenantId, id: { in: d.planIds } }, select: { id: true } }),
  ]);

  await prisma.doctor.create({
    data: {
      tenantId,
      name: d.name,
      crm: d.crm || null,
      specialties: { connect: specialties.map((s) => ({ id: s.id })) },
      units: { connect: units.map((u) => ({ id: u.id })) },
      healthPlans: { connect: plans.map((p) => ({ id: p.id })) },
    },
  });
}

export async function updateDoctorCalendarId(tenantId: string, doctorId: string, calendarId?: string) {
  await prisma.doctor.updateMany({
    where: { id: doctorId, tenantId },
    data: { googleCalendarId: calendarId?.trim() || null },
  });
}

/** Salva a agenda própria do dentista. `null` = herda o horário da clínica. */
export async function updateDoctorHours(
  tenantId: string,
  doctorId: string,
  days: Record<number, { open: string; close: string } | null> | null,
) {
  await prisma.doctor.updateMany({
    where: { id: doctorId, tenantId },
    data: { workingHours: days ? JSON.stringify(days) : null },
  });
}

/** Exclusão escopada por tenant. Retorna erro amigável se houver vínculos. */
export async function remove(
  tenantId: string,
  entity: "unit" | "specialty" | "insurer" | "healthPlan" | "doctor",
  id: string,
): Promise<{ ok: true } | { ok: false; erro: string }> {
  try {
    switch (entity) {
      case "unit":
        await prisma.unit.deleteMany({ where: { id, tenantId } });
        break;
      case "specialty":
        await prisma.specialty.deleteMany({ where: { id, tenantId } });
        break;
      case "insurer":
        await prisma.insurer.deleteMany({ where: { id, tenantId } });
        break;
      case "healthPlan":
        await prisma.healthPlan.deleteMany({ where: { id, tenantId } });
        break;
      case "doctor":
        await prisma.doctor.deleteMany({ where: { id, tenantId } });
        break;
    }
    return { ok: true };
  } catch {
    return { ok: false, erro: "Não foi possível excluir: há agendamentos ou horários vinculados." };
  }
}

// ---------- Agenda ----------
export async function generateAgenda(tenantId: string, days: number) {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const config = JSON.parse(t.config) as TenantConfig;
  return regenerateSlots(prisma, { tenantId, timezone: t.timezone, config, slotDays: days });
}

// ---------- Conversas (memória do agente) ----------
export async function listConversations(tenantId: string) {
  return prisma.conversation.findMany({
    where: { tenantId },
    orderBy: { lastMessageAt: "desc" },
    take: 20,
    select: { patientPhone: true, lastMessageAt: true },
  });
}

/** Apaga a memória de uma conversa (o próximo "oi" começa do zero). */
export async function resetConversation(tenantId: string, phone: string) {
  await prisma.conversation.deleteMany({ where: { tenantId, patientPhone: phone.trim() } });
}

// ---------- Caixa de entrada (transbordo humano) ----------

/** Conversas para o inbox: pendentes de atendimento humano primeiro. */
export async function listInbox(tenantId: string, timezone: string) {
  const convs = await prisma.conversation.findMany({
    where: { tenantId },
    orderBy: [{ humanHandoff: "desc" }, { lastMessageAt: "desc" }],
    take: 50,
    select: { patientPhone: true, humanHandoff: true, handoffAt: true, lastMessageAt: true },
  });

  // Última mensagem de cada conversa, para prévia na lista.
  const ultimas = await Promise.all(
    convs.map((c) =>
      prisma.message.findFirst({
        where: { tenantId, phone: c.patientPhone },
        orderBy: { createdAt: "desc" },
        select: { text: true, direction: true },
      }),
    ),
  );

  return convs.map((c, i) => ({
    telefone: c.patientPhone,
    aguardando: c.humanHandoff,
    ultimaEm: c.lastMessageAt,
    ultimaEmTexto: formatarHoraCurta(c.lastMessageAt, timezone),
    previa: ultimas[i]?.text?.slice(0, 90) ?? "",
    ultimaDirecao: ultimas[i]?.direction ?? "",
    /** A Meta só permite resposta livre até 24h após a última mensagem do paciente. */
    janelaAberta: Date.now() - c.lastMessageAt.getTime() < 24 * 3600 * 1000,
  }));
}

export async function countPendentes(tenantId: string): Promise<number> {
  return prisma.conversation.count({ where: { tenantId, humanHandoff: true } });
}

/** Histórico legível de uma conversa. */
export async function listThread(tenantId: string, phone: string, timezone: string) {
  const msgs = await prisma.message.findMany({
    where: { tenantId, phone },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return msgs.map((m) => ({
    id: m.id,
    texto: m.text,
    entrada: m.direction === "IN",
    autor: m.sentBy,
    quando: m.createdAt,
    quandoTexto: formatarHoraCurta(m.createdAt, timezone),
  }));
}

export async function listAppointments(tenantId: string, timezone: string) {
  const now = new Date();
  const appts = await prisma.appointment.findMany({
    where: { tenantId, slot: { startsAt: { gte: now } } },
    include: { patient: true, doctor: true, unit: true, specialty: true, slot: true },
    orderBy: { slot: { startsAt: "asc" } },
    take: 100,
  });
  return appts.map((a) => ({
    id: a.id,
    paciente: a.patient.name,
    especialidade: a.specialty.name,
    medico: a.doctor.name,
    unidade: a.unit.name,
    inicio: formatDateTime(a.slot.startsAt, timezone),
    status: a.status,
    statusLabel: statusUI(a.status).label,
    statusCss: statusUI(a.status).css,
    cancelado: a.status === AppointmentStatus.CANCELLED,
  }));
}

/** Eventos (formato FullCalendar) num intervalo — alimenta a tela de calendário. */
export async function listAppointmentsRange(
  tenantId: string,
  fromISO: string,
  toISO: string,
  opts: { doctorId?: string } = {},
) {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { tenantId, slot: { startsAt: { gte: from, lt: to } } };
  if (opts.doctorId) where.doctorId = opts.doctorId;

  const appts = await prisma.appointment.findMany({
    where,
    include: { patient: true, doctor: true, unit: true, specialty: true, slot: true },
    orderBy: { slot: { startsAt: "asc" } },
    take: 1000,
  });

  // A cor vem de uma classe CSS (não de um hex fixo) para o evento acompanhar o
  // tema claro/escuro do painel — os tokens vivem em views/admin/partials/head.ejs.
  const classe = (status: string) => {
    if (status === AppointmentStatus.CANCELLED) return "ev-cancelado";
    if (status === AppointmentStatus.NO_SHOW) return "ev-faltou";
    if (status === AppointmentStatus.CONFIRMED) return "ev-confirmado";
    if (status === AppointmentStatus.RESCHEDULED) return "ev-remarcado";
    return "ev-agendado";
  };

  return appts.map((a) => ({
    id: a.id,
    title: `${a.patient.name} · ${a.specialty.name}`,
    start: a.slot.startsAt.toISOString(),
    end: a.slot.endsAt.toISOString(),
    classNames: [classe(a.status)],
    extendedProps: {
      medico: a.doctor.name,
      unidade: a.unit.name,
      status: statusUI(a.status).label, // exibido no painel, em português
    },
  }));
}

// ---------- Usuários do painel ----------

export async function listUsers() {
  return prisma.adminUser.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }],
    include: { tenant: { select: { name: true } } },
  });
}

export async function createUser(d: {
  email: string;
  name: string;
  passwordHash: string;
  role: string;
  tenantId?: string | null;
}) {
  await prisma.adminUser.create({
    data: {
      email: d.email.trim().toLowerCase(),
      name: d.name.trim(),
      passwordHash: d.passwordHash,
      role: d.role,
      tenantId: d.role === "CLINIC" ? (d.tenantId || null) : null,
    },
  });
}

export async function setUserActive(id: string, ativo: boolean) {
  await prisma.adminUser.update({ where: { id }, data: { isActive: ativo } });
}

export async function setUserPassword(id: string, passwordHash: string) {
  await prisma.adminUser.update({ where: { id }, data: { passwordHash } });
}

export async function deleteUser(id: string) {
  await prisma.adminUser.delete({ where: { id } });
}

// ---------- Bloqueios (férias, feriados, ausências) ----------

export async function listBlocks(tenantId: string, timezone: string) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const blocks = await prisma.block.findMany({
    where: { tenantId, endsAt: { gte: hoje } },
    orderBy: { startsAt: "asc" },
    include: { doctor: { select: { name: true } } },
  });

  return blocks.map((b) => ({
    id: b.id,
    quem: b.doctor?.name ?? "Toda a clínica",
    inicio: formatDateTime(b.startsAt, timezone),
    fim: formatDateTime(b.endsAt, timezone),
    motivo: b.reason ?? "",
  }));
}

/**
 * Cria um bloqueio e avisa se ele cobre agendamentos já marcados — nunca
 * cancela nada automaticamente; a recepção decide o que fazer.
 */
export async function addBlock(
  tenantId: string,
  d: { doctorId?: string | null; startsAt: string; endsAt: string; reason?: string },
  timezone: string,
): Promise<{ ok: true; conflitos: string[] } | { ok: false; erro: string }> {
  const inicio = new Date(d.startsAt);
  const fim = new Date(d.endsAt);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
    return { ok: false, erro: "Datas inválidas." };
  }
  if (fim <= inicio) return { ok: false, erro: "O fim precisa ser depois do início." };

  await prisma.block.create({
    data: {
      tenantId,
      doctorId: d.doctorId || null,
      startsAt: inicio,
      endsAt: fim,
      reason: d.reason?.trim() || null,
    },
  });

  // Consultas já marcadas dentro do período.
  const agendados = await prisma.appointment.findMany({
    where: {
      tenantId,
      ...(d.doctorId ? { doctorId: d.doctorId } : {}),
      status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
      slot: { startsAt: { gte: inicio, lt: fim } },
    },
    include: { patient: true, doctor: true, slot: true },
    take: 50,
  });

  return {
    ok: true,
    conflitos: agendados.map(
      (a) => `${a.patient.name} — ${formatDateTime(a.slot.startsAt, timezone)} (${a.doctor.name})`,
    ),
  };
}

export async function removeBlock(tenantId: string, id: string) {
  await prisma.block.deleteMany({ where: { id, tenantId } });
}

/** Consultas passadas ainda sem desfecho — a recepção marca Compareceu/Faltou. */
export async function listPendingAttendance(tenantId: string, timezone: string) {
  const appts = await prisma.appointment.findMany({
    where: {
      tenantId,
      status: {
        in: [
          AppointmentStatus.SCHEDULED,
          AppointmentStatus.CONFIRMED,
          AppointmentStatus.RESCHEDULED,
        ],
      },
      slot: { endsAt: { lt: new Date() } },
    },
    include: { patient: true, doctor: true, specialty: true, slot: true },
    orderBy: { slot: { startsAt: "desc" } },
    take: 30,
  });

  return appts.map((a) => ({
    id: a.id,
    paciente: a.patient.name,
    especialidade: a.specialty.name,
    medico: a.doctor.name,
    inicio: formatDateTime(a.slot.startsAt, timezone),
  }));
}

// =========================================================
// PACIENTES — busca e ficha individual
// =========================================================

/** Consultas que já aconteceram: só elas entram no cálculo de falta. */
const REALIZADOS = [AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW];

export type OrdemPacientes = "recentes" | "consultas" | "faltas" | "sumidos";

/**
 * Lista paginada com busca. O termo casa contra nome, CPF ou telefone — a
 * recepção digita o que tiver em mãos. O CPF é comparado só por dígitos, senão
 * "123.456" nunca acharia "12345678900".
 */
export async function listPatients(
  tenantId: string,
  timezone: string,
  opts: { q?: string; ordem?: OrdemPacientes; pagina?: number; porPagina?: number } = {},
) {
  const q = (opts.q ?? "").trim();
  const ordem = opts.ordem ?? "recentes";
  const porPagina = opts.porPagina ?? 25;
  const pagina = Math.max(1, opts.pagina ?? 1);

  const digitos = q.replace(/\D/g, "");
  const where = {
    tenantId,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            ...(digitos ? [{ cpf: { contains: digitos } }, { phone: { contains: digitos } }] : []),
          ],
        }
      : {}),
  };

  // "sumidos" e os rankings dependem de contagens por status, que o Prisma não
  // ordena direto. Nas ordens agregadas buscamos o conjunto filtrado e ordenamos
  // em memória; o painel é de uma clínica só, então o volume é tratável.
  const agregada = ordem !== "recentes";
  const total = await prisma.patient.count({ where });

  const pacientes = await prisma.patient.findMany({
    where,
    orderBy: { createdAt: "desc" },
    ...(agregada ? {} : { skip: (pagina - 1) * porPagina, take: porPagina }),
    ...(agregada ? { take: 500 } : {}),
    include: {
      appointments: { select: { status: true, slot: { select: { startsAt: true } } } },
      insurances: { include: { healthPlan: { select: { name: true } } }, take: 1, orderBy: { isPrimary: "desc" } },
    },
  });

  const agora = Date.now();
  let linhas = pacientes.map((p) => {
    const consultas = p.appointments.length;
    const faltas = p.appointments.filter((a) => a.status === AppointmentStatus.NO_SHOW).length;
    const realizadas = p.appointments.filter((a) => REALIZADOS.includes(a.status as never)).length;
    const passadas = p.appointments
      .map((a) => a.slot.startsAt)
      .filter((d) => d.getTime() <= agora)
      .sort((a, b) => b.getTime() - a.getTime());
    const futuras = p.appointments
      .map((a) => a.slot.startsAt)
      .filter((d) => d.getTime() > agora)
      .sort((a, b) => a.getTime() - b.getTime());
    const ultima = passadas[0] ?? null;

    return {
      id: p.id,
      nome: p.name,
      cpf: formatarCpf(p.cpf),
      telefone: p.phone,
      convenio: p.insurances[0]?.healthPlan.name ?? null,
      consultas,
      faltas,
      taxaFalta: realizadas ? (faltas / realizadas) * 100 : null,
      ultimaEm: ultima,
      ultimaTexto: ultima ? formatarDia(ultima, timezone) : null,
      proximaTexto: futuras[0] ? formatDateTime(futuras[0], timezone) : null,
      diasSemVir: ultima ? Math.floor((agora - ultima.getTime()) / 86400000) : null,
    };
  });

  if (ordem === "consultas") linhas.sort((a, b) => b.consultas - a.consultas);
  else if (ordem === "faltas") {
    // Empate por número absoluto de faltas desempata pela taxa: 3 faltas em 4
    // consultas é um problema maior que 3 em 40.
    linhas.sort((a, b) => b.faltas - a.faltas || (b.taxaFalta ?? -1) - (a.taxaFalta ?? -1));
  } else if (ordem === "sumidos") {
    // Sem consulta futura marcada e sem vir há mais tempo primeiro. Quem nunca
    // veio não é "sumido", é novo — fica de fora.
    linhas = linhas.filter((l) => !l.proximaTexto && l.diasSemVir !== null);
    linhas.sort((a, b) => (b.diasSemVir ?? 0) - (a.diasSemVir ?? 0));
  }

  const totalFiltrado = agregada ? linhas.length : total;
  if (agregada) linhas = linhas.slice((pagina - 1) * porPagina, pagina * porPagina);

  return {
    linhas,
    total: totalFiltrado,
    pagina,
    porPagina,
    paginas: Math.max(1, Math.ceil(totalFiltrado / porPagina)),
  };
}

/** Ficha completa de um paciente: dados, métricas e histórico. */
export async function getPatient(tenantId: string, patientId: string, timezone: string) {
  const p = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    include: {
      insurances: { include: { healthPlan: { include: { insurer: true } } } },
      appointments: {
        include: { doctor: true, specialty: true, unit: true, slot: true, healthPlan: true },
        orderBy: { slot: { startsAt: "desc" } },
      },
      waitlist: { include: { specialty: true }, where: { status: "ACTIVE" } },
    },
  });
  if (!p) return null;

  const agora = Date.now();
  const porStatus = (s: string) => p.appointments.filter((a) => a.status === s).length;
  const faltas = porStatus(AppointmentStatus.NO_SHOW);
  const compareceu = porStatus(AppointmentStatus.COMPLETED);
  const realizadas = faltas + compareceu;

  const ordenadas = [...p.appointments].sort(
    (a, b) => a.slot.startsAt.getTime() - b.slot.startsAt.getTime(),
  );
  const passadas = ordenadas.filter((a) => a.slot.startsAt.getTime() <= agora);
  const futuras = ordenadas.filter((a) => a.slot.startsAt.getTime() > agora);

  // Especialidade e profissional mais frequentes — dizem de quem o paciente é.
  const maisFrequente = (nomes: string[]) => {
    const contagem = new Map<string, number>();
    nomes.forEach((n) => contagem.set(n, (contagem.get(n) ?? 0) + 1));
    let topo: string | null = null;
    let max = 0;
    contagem.forEach((qtd, nome) => {
      if (qtd > max) { max = qtd; topo = nome; }
    });
    return topo;
  };

  const ultima = passadas[passadas.length - 1] ?? null;
  const conversa = await prisma.conversation.findFirst({
    where: { tenantId, patientPhone: p.phone },
    select: { lastMessageAt: true, humanHandoff: true },
  });

  return {
    id: p.id,
    nome: p.name,
    cpf: formatarCpf(p.cpf),
    telefone: p.phone,
    nascimento: p.birthDate ? formatarDia(p.birthDate, timezone) : null,
    idade: p.birthDate ? calcularIdade(p.birthDate) : null,
    clienteDesde: formatarDia(p.createdAt, timezone),
    ultimoRecall: p.lastRecallAt ? formatarDia(p.lastRecallAt, timezone) : null,

    convenios: p.insurances.map((i) => ({
      plano: i.healthPlan.name,
      operadora: i.healthPlan.insurer.name,
      carteirinha: i.cardNumber,
      principal: i.isPrimary,
      validade: i.validThru ? formatarDia(i.validThru, timezone) : null,
    })),

    filaEspera: p.waitlist.map((w) => ({ especialidade: w.specialty.name, periodo: w.periodo })),

    metricas: {
      total: p.appointments.length,
      compareceu,
      faltas,
      realizadas,
      cancelados: porStatus(AppointmentStatus.CANCELLED),
      remarcados: porStatus(AppointmentStatus.RESCHEDULED),
      agendados: futuras.length,
      taxaFalta: realizadas ? (faltas / realizadas) * 100 : null,
      taxaPresenca: realizadas ? (compareceu / realizadas) * 100 : null,
      particular: p.appointments.filter((a) => !a.healthPlanId).length,
      convenio: p.appointments.filter((a) => a.healthPlanId).length,
      primeiraTexto: passadas[0] ? formatarDia(passadas[0].slot.startsAt, timezone) : null,
      ultimaTexto: ultima ? formatarDia(ultima.slot.startsAt, timezone) : null,
      diasSemVir: ultima ? Math.floor((agora - ultima.slot.startsAt.getTime()) / 86400000) : null,
      especialidadeTop: maisFrequente(p.appointments.map((a) => a.specialty.name)),
      medicoTop: maisFrequente(p.appointments.map((a) => a.doctor.name)),
    },

    proxima: futuras[0]
      ? {
          quando: formatDateTime(futuras[0].slot.startsAt, timezone),
          especialidade: futuras[0].specialty.name,
          medico: futuras[0].doctor.name,
          statusLabel: statusUI(futuras[0].status).label,
          statusCss: statusUI(futuras[0].status).css,
        }
      : null,

    historico: p.appointments.map((a) => ({
      id: a.id,
      quando: formatDateTime(a.slot.startsAt, timezone),
      futuro: a.slot.startsAt.getTime() > agora,
      especialidade: a.specialty.name,
      medico: a.doctor.name,
      unidade: a.unit.name,
      pagamento: a.healthPlan ? a.healthPlan.name : "Particular",
      statusLabel: statusUI(a.status).label,
      statusCss: statusUI(a.status).css,
    })),

    conversa: conversa
      ? {
          ultimaEm: formatarDia(conversa.lastMessageAt, timezone),
          aguardando: conversa.humanHandoff,
        }
      : null,
  };
}

/** 12345678900 -> 123.456.789-00. Deixa passar o que não tiver 11 dígitos. */
function formatarCpf(cpf: string): string {
  const d = (cpf ?? "").replace(/\D/g, "");
  if (d.length !== 11) return cpf ?? "";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function calcularIdade(nascimento: Date): number {
  const hoje = new Date();
  let idade = hoje.getFullYear() - nascimento.getFullYear();
  const m = hoje.getMonth() - nascimento.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < nascimento.getDate())) idade--;
  return idade;
}

// ---------- Usuários de UMA clínica ----------

/** Só os usuários desta clínica. SUPER não aparece: não é gerido pela clínica. */
export async function listUsersByTenant(tenantId: string) {
  return prisma.adminUser.findMany({
    where: { tenantId, role: "CLINIC" },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
}

/**
 * Cria um usuário preso a esta clínica. O papel e o tenant são fixados aqui, no
 * servidor — nada do corpo do formulário decide isso, senão bastaria mandar
 * role=SUPER no POST para virar administrador da plataforma.
 */
export async function createTenantUser(
  tenantId: string,
  d: { email: string; name: string; passwordHash: string },
) {
  await prisma.adminUser.create({
    data: {
      email: d.email.trim().toLowerCase(),
      name: d.name.trim(),
      passwordHash: d.passwordHash,
      role: "CLINIC",
      tenantId,
    },
  });
}

/** Carrega o alvo de uma ação para conferir a permissão antes de executá-la. */
export async function findAdminUser(id: string) {
  return prisma.adminUser.findUnique({
    where: { id },
    select: { id: true, role: true, tenantId: true, name: true, isActive: true },
  });
}
