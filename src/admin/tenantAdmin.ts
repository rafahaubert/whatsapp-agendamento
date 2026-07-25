/**
 * Operações de administração sobre clínicas e catálogo. Camada fina sobre o
 * Prisma, usada pelas rotas do painel. Tudo escopado por tenantId.
 */
import { prisma } from "../db/client.js";
import { regenerateSlots } from "../db/seed.js";
import { AppointmentStatus } from "../shared/enums.js";
import { formatDateTime } from "../shared/datetime.js";
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
  await prisma.healthPlan.create({ data: { tenantId, insurerId, name } });
}

export async function addDoctor(
  tenantId: string,
  d: { name: string; crm?: string; specialtyIds: string[]; unitIds: string[]; planIds: string[] },
) {
  await prisma.doctor.create({
    data: {
      tenantId,
      name: d.name,
      crm: d.crm || null,
      specialties: { connect: d.specialtyIds.map((id) => ({ id })) },
      units: { connect: d.unitIds.map((id) => ({ id })) },
      healthPlans: { connect: d.planIds.map((id) => ({ id })) },
    },
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
    cancelado: a.status === AppointmentStatus.CANCELLED,
  }));
}
