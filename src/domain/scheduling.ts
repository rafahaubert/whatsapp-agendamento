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
import { formatDateTime } from "../shared/datetime.js";
import { normalizeCpf, isValidCpf } from "../shared/cpf.js";
import { logger } from "../shared/logger.js";
import {
  isGoogleConfigured,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../integrations/googleCalendar.js";
import type { ResolvedTenant } from "../db/tenantRepository.js";

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
  return insurers.map((i) => ({ convenio: i.name, planos: i.plans.map((p) => p.name) }));
}

// ---------- Médicos e suas agendas ----------
const DIAS_ABREV = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "seg, ter, qua: 08:30 às 22:30 · sáb: 08:00 às 12:00" */
export function resumoAgenda(days: Record<number, { open: string; close: string } | null>): string {
  const grupos = new Map<string, number[]>();
  for (let d = 0; d < 7; d++) {
    const h = days[d];
    if (!h) continue;
    const chave = `${h.open} às ${h.close}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave)!.push(d);
  }
  if (grupos.size === 0) return "sem dias de atendimento definidos";
  return [...grupos.entries()]
    .map(([faixa, dias]) => `${dias.map((d) => DIAS_ABREV[d]).join(", ")}: ${faixa}`)
    .join(" · ");
}

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
      let agenda = tenant.config.businessHours.days;
      let agendaPropria = false;
      if (d.workingHours) {
        try {
          agenda = JSON.parse(d.workingHours);
          agendaPropria = true;
        } catch {
          /* usa o horário da clínica */
        }
      }
      return {
        nome: d.name,
        especialidades: d.specialties.map((s) => s.name),
        unidades: d.units.map((u) => u.name),
        atende: resumoAgenda(agenda),
        agendaPropria,
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

// ---------- Horários ----------
/** Faixas de hora local por período do dia. */
const PERIODOS: Record<string, [number, number]> = {
  manha: [0, 12],
  tarde: [12, 18],
  noite: [18, 24],
};

export async function listAvailableSlots(
  tenant: ResolvedTenant,
  opts: {
    especialidade: string;
    unidade?: string;
    plano?: string;
    periodo?: string;
    horaPreferida?: number;
    medico?: string;
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

  // Busca uma janela maior e filtra por período / hora (local) antes de cortar em N.
  const encontrados = await prisma.slot.findMany({
    where,
    orderBy: { startsAt: "asc" },
    take: 300,
    include: { doctor: true, unit: true },
  });

  const horaLocal = (d: Date) => {
    const dt = DateTime.fromJSDate(d).setZone(tenant.timezone);
    return dt.hour + dt.minute / 60;
  };

  const faixa = opts.periodo ? PERIODOS[opts.periodo.trim().toLowerCase()] : undefined;
  let filtrados = faixa
    ? encontrados.filter((s) => {
        const h = horaLocal(s.startsAt);
        return h >= faixa[0] && h < faixa[1];
      })
    : encontrados;

  // Preferência de horário específico ("pelas 22h"): ordena pelos mais próximos.
  if (opts.horaPreferida != null && Number.isFinite(opts.horaPreferida)) {
    const alvo = opts.horaPreferida;
    filtrados = [...filtrados].sort(
      (a, b) => Math.abs(horaLocal(a.startsAt) - alvo) - Math.abs(horaLocal(b.startsAt) - alvo),
    );
  }

  const escolhidos = filtrados.slice(0, tenant.config.booking.maxOptionsOffered);

  if (escolhidos.length === 0) {
    return {
      horarios: [],
      aviso: opts.periodo
        ? `Nenhum horário livre no período "${opts.periodo}". Há horários em outros períodos?`
        : "Nenhum horário livre encontrado com esses critérios.",
    };
  }

  return {
    horarios: escolhidos.map((s) => ({
      slotId: s.id,
      medico: s.doctor.name,
      unidade: s.unit.name,
      inicio: formatDateTime(s.startsAt, tenant.timezone),
    })),
  };
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

  const outcome = await prisma.$transaction(async (tx) => {
    const slot = await tx.slot.findFirst({
      where: { id: slotId, tenantId },
      include: { doctor: true, unit: true, specialty: true },
    });
    if (!slot) return { erro: "Horário não encontrado." };
    if (slot.status !== SlotStatus.AVAILABLE) {
      return { erro: "Esse horário acabou de ser reservado. Escolha outro." };
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
    await tx.slot.update({ where: { id: slot.id }, data: { status: SlotStatus.BOOKED } });
    return { appt, slot };
  });

  if ("erro" in outcome) return outcome;
  const { appt, slot } = outcome;

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
  const outcome = await prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, tenantId: tenant.id },
      include: { doctor: { select: { googleCalendarId: true } } },
    });
    if (!appt) return { erro: "Agendamento não encontrado." };
    if (appt.status === AppointmentStatus.CANCELLED) return { erro: "Esse agendamento já está cancelado." };

    await tx.appointment.update({ where: { id: appt.id }, data: { status: AppointmentStatus.CANCELLED } });
    await tx.slot.update({ where: { id: appt.slotId }, data: { status: SlotStatus.AVAILABLE } });
    return { appt };
  });

  if ("erro" in outcome) return outcome;
  const { appt } = outcome;

  if (appt.googleEventId && appt.doctor.googleCalendarId && isGoogleConfigured()) {
    try {
      await deleteEvent(appt.doctor.googleCalendarId, appt.googleEventId);
    } catch (err) {
      logger.error({ err, appointmentId: appt.id }, "falha ao remover evento do Google Calendar");
    }
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
  const outcome = await prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, tenantId: tenant.id },
      include: { doctor: { select: { googleCalendarId: true } } },
    });
    if (!appt) return { erro: "Agendamento não encontrado." };

    const novo = await tx.slot.findFirst({
      where: { id: novoSlotId, tenantId: tenant.id },
      include: { doctor: true, unit: true, specialty: true },
    });
    if (!novo) return { erro: "Novo horário não encontrado." };
    if (novo.status !== SlotStatus.AVAILABLE) return { erro: "Esse horário não está mais livre." };

    await tx.slot.update({ where: { id: appt.slotId }, data: { status: SlotStatus.AVAILABLE } });
    await tx.slot.update({ where: { id: novo.id }, data: { status: SlotStatus.BOOKED } });
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
  const startsAt = new Date(p.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { erro: "Data/hora inválida." };

  const paciente = await findOrCreatePatient(tenant.id, {
    nome: p.nome,
    cpf: p.cpf,
    phone: p.telefone ?? "",
  });
  if ("erro" in paciente) return paciente;

  const doctor = await prisma.doctor.findFirst({ where: { id: p.doctorId, tenantId: tenant.id } });
  if (!doctor) return { erro: "Dentista não encontrado." };

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
  const startsAt = new Date(novoInicioISO);
  if (Number.isNaN(startsAt.getTime())) return { erro: "Data/hora inválida." };

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
