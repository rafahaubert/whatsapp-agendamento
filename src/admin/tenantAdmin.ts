/**
 * Operações de administração sobre clínicas e catálogo. Camada fina sobre o
 * Prisma, usada pelas rotas do painel. Tudo escopado por tenantId.
 */
import { prisma } from "../db/client.js";
import { regenerateSlots } from "../db/seed.js";
import { AppointmentStatus, statusUI } from "../shared/enums.js";
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
export async function listInbox(tenantId: string) {
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
export async function listThread(tenantId: string, phone: string) {
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

  const cor = (status: string) => {
    if (status === AppointmentStatus.CANCELLED) return "#9aa5ab";
    if (status === AppointmentStatus.NO_SHOW) return "#c0392b";
    return "#128c7e";
  };

  return appts.map((a) => ({
    id: a.id,
    title: `${a.patient.name} · ${a.specialty.name}`,
    start: a.slot.startsAt.toISOString(),
    end: a.slot.endsAt.toISOString(),
    color: cor(a.status),
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
