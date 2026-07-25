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
  opts: { especialidade: string; unidade?: string; plano?: string; periodo?: string },
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

  // Busca uma janela maior e filtra por período (hora local) antes de cortar em N.
  const encontrados = await prisma.slot.findMany({
    where,
    orderBy: { startsAt: "asc" },
    take: 200,
    include: { doctor: true, unit: true },
  });

  const faixa = opts.periodo ? PERIODOS[opts.periodo.trim().toLowerCase()] : undefined;
  const filtrados = faixa
    ? encontrados.filter((s) => {
        const hora = DateTime.fromJSDate(s.startsAt).setZone(tenant.timezone).hour;
        return hora >= faixa[0] && hora < faixa[1];
      })
    : encontrados;

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
  return prisma.$transaction(async (tx) => {
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

    return {
      appointmentId: appt.id,
      medico: slot.doctor.name,
      unidade: slot.unit.name,
      especialidade: slot.specialty.name,
      inicio: formatDateTime(slot.startsAt, tenant.timezone),
      status: "AGENDADO",
    };
  });
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
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findFirst({ where: { id: appointmentId, tenantId: tenant.id } });
    if (!appt) return { erro: "Agendamento não encontrado." };
    if (appt.status === AppointmentStatus.CANCELLED) return { erro: "Esse agendamento já está cancelado." };

    await tx.appointment.update({ where: { id: appt.id }, data: { status: AppointmentStatus.CANCELLED } });
    await tx.slot.update({ where: { id: appt.slotId }, data: { status: SlotStatus.AVAILABLE } });
    return { status: "CANCELADO", appointmentId: appt.id };
  });
}

export async function rescheduleAppointment(
  tenant: ResolvedTenant,
  appointmentId: string,
  novoSlotId: string,
) {
  if (!tenant.config.booking.allowReschedule) {
    return { erro: "Remarcação não permitida pelo assistente." };
  }
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findFirst({ where: { id: appointmentId, tenantId: tenant.id } });
    if (!appt) return { erro: "Agendamento não encontrado." };

    const novo = await tx.slot.findFirst({
      where: { id: novoSlotId, tenantId: tenant.id },
      include: { doctor: true, unit: true },
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

    return {
      status: "REMARCADO",
      appointmentId: updated.id,
      medico: novo.doctor.name,
      unidade: novo.unit.name,
      inicio: formatDateTime(novo.startsAt, tenant.timezone),
    };
  });
}
