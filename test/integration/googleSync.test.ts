import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "../../src/db/client.js";
import { seedClinic, regenerateSlots } from "../../src/db/seed.js";
import { SlotStatus } from "../../src/shared/enums.js";
import type { ClinicFile, TenantConfig } from "../../src/config/types.js";

/**
 * A chamada ao Google é o único efeito externo. Mockada, os testes exercitam o
 * que de fato quebrava: a RECONCILIAÇÃO — o que vira bloqueio, o que é nosso e
 * não pode virar, e o que precisa ser desfeito.
 */
const periodosOcupados = vi.fn();
vi.mock("../../src/integrations/googleCalendar.js", () => ({
  isGoogleConfigured: () => true,
  listBusyIntervals: (...a: unknown[]) => periodosOcupados(...a),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  serviceAccountEmail: () => "conta@servico.iam.gserviceaccount.com",
}));

const { sincronizarAgendaDoProfissional, PREFIXO_GOOGLE } = await import(
  "../../src/jobs/googleSync.js"
);

const TZ = "America/Sao_Paulo";

const clinicFile: ClinicFile = {
  slug: "clinica-google",
  name: "Clínica Google",
  whatsappPhoneNumberId: "test-google-000",
  timezone: TZ,
  config: {
    branding: {
      clinicName: "Clínica Google",
      greetingMessage: "Olá!",
      fallbackMessage: "Não entendi.",
      closingMessage: "Até breve!",
    },
    businessHours: {
      timezone: TZ,
      days: {
        0: { open: "08:00", close: "18:00" },
        1: { open: "08:00", close: "18:00" },
        2: { open: "08:00", close: "18:00" },
        3: { open: "08:00", close: "18:00" },
        4: { open: "08:00", close: "18:00" },
        5: { open: "08:00", close: "18:00" },
        6: { open: "08:00", close: "18:00" },
      },
    },
    booking: {
      slotDurationMinutes: 30,
      maxOptionsOffered: 3,
      advanceBookingDays: 30,
      allowCancellation: true,
      allowReschedule: true,
      askInsurance: false,
      acceptParticular: true,
      googleSync: { enabled: true },
    },
    ai: { model: "claude-haiku-4-5", persona: "Objetivo." },
  },
  catalog: {
    units: [{ name: "Unidade Central" }],
    specialties: ["Clínico Geral"],
    insurers: [],
    doctors: [{ name: "Dr. Google", specialties: ["Clínico Geral"], units: ["Unidade Central"] }],
  },
};

let tenantId = "";
let doctorId = "";
let config: TenantConfig;

/** Amanhã às 14h no fuso da clínica — bem dentro da janela gerada. */
const amanha = (hora: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hora + 3, 0, 0, 0); // UTC-3
  return d;
};

async function bloqueiosDoGoogle() {
  return prisma.block.findMany({
    where: { tenantId, reason: { startsWith: PREFIXO_GOOGLE } },
    orderBy: { startsAt: "asc" },
  });
}

async function sincronizar(agora = new Date()) {
  return sincronizarAgendaDoProfissional(
    tenantId,
    doctorId,
    "agenda@do-dentista.com",
    30,
    new Set<string>(),
    agora,
  );
}

beforeAll(async () => {
  const r = await seedClinic(prisma, clinicFile, { slotDays: 3 });
  tenantId = r.tenantId;
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  config = JSON.parse(t.config) as TenantConfig;
  const d = await prisma.doctor.findFirstOrThrow({ where: { tenantId } });
  doctorId = d.id;
  await prisma.doctor.update({
    where: { id: doctorId },
    data: { googleCalendarId: "agenda@do-dentista.com" },
  });
});

beforeEach(async () => {
  periodosOcupados.mockReset();
  await prisma.block.deleteMany({ where: { tenantId } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("Google → sistema (integração)", () => {
  // REGRESSÃO: o SECURITY.md registrava a falha com todas as letras — a
  // integração só ESCREVIA. O dentista marcava um congresso pelo celular e o
  // agente seguia oferecendo aquele horário; o paciente aparecia para uma sala
  // vazia.
  it("compromisso do Google vira bloqueio", async () => {
    periodosOcupados.mockResolvedValue([
      { eventId: "congresso-1", startsAt: amanha(14), endsAt: amanha(18) },
    ]);

    const r = await sincronizar();
    expect(r.criados).toBe(1);

    const blocos = await bloqueiosDoGoogle();
    expect(blocos).toHaveLength(1);
    expect(blocos[0].doctorId).toBe(doctorId);
    expect(blocos[0].startsAt.toISOString()).toBe(amanha(14).toISOString());
  });

  it("e o bloqueio tira os horários da agenda", async () => {
    periodosOcupados.mockResolvedValue([
      { eventId: "congresso-1", startsAt: amanha(14), endsAt: amanha(18) },
    ]);
    await sincronizar();
    await regenerateSlots(prisma, { tenantId, timezone: TZ, config, slotDays: 3 });

    const dentroDoCongresso = await prisma.slot.count({
      where: {
        tenantId,
        doctorId,
        status: SlotStatus.AVAILABLE,
        startsAt: { gte: amanha(14), lt: amanha(18) },
      },
    });
    expect(dentroDoCongresso).toBe(0);

    // E a agenda do resto do dia continua de pé.
    const foraDele = await prisma.slot.count({
      where: {
        tenantId,
        doctorId,
        status: SlotStatus.AVAILABLE,
        startsAt: { gte: amanha(8), lt: amanha(12) },
      },
    });
    expect(foraDele).toBeGreaterThan(0);
  });

  // O ponto mais delicado: nós ESCREVEMOS as consultas nesse mesmo calendário.
  // Tratá-las como compromisso externo fecharia a agenda progressivamente
  // sozinha — e, depois de um cancelamento, o bloqueio sobreviveria ao evento.
  it("não trata as NOSSAS consultas como compromisso externo", async () => {
    periodosOcupados.mockResolvedValue([
      { eventId: "consulta-nossa", startsAt: amanha(9), endsAt: amanha(10) },
      { eventId: "congresso-1", startsAt: amanha(14), endsAt: amanha(18) },
    ]);

    const r = await sincronizarAgendaDoProfissional(
      tenantId,
      doctorId,
      "agenda@do-dentista.com",
      30,
      new Set(["consulta-nossa"]),
      new Date(),
    );

    expect(r.criados).toBe(1);
    const blocos = await bloqueiosDoGoogle();
    expect(blocos).toHaveLength(1);
    expect(blocos[0].startsAt.toISOString()).toBe(amanha(14).toISOString());
  });

  it("rodar de novo não duplica", async () => {
    periodosOcupados.mockResolvedValue([
      { eventId: "congresso-1", startsAt: amanha(14), endsAt: amanha(18) },
    ]);
    await sincronizar();

    const r = await sincronizar();
    expect(r.criados).toBe(0);
    expect(r.removidos).toBe(0);
    expect(await bloqueiosDoGoogle()).toHaveLength(1);
  });

  // Sem esta ponta, apagar o compromisso no Google deixaria o horário fechado
  // para sempre — e a clínica perderia agenda sem entender por quê.
  it("apagar o compromisso no Google devolve o horário", async () => {
    periodosOcupados.mockResolvedValue([
      { eventId: "congresso-1", startsAt: amanha(14), endsAt: amanha(18) },
    ]);
    await sincronizar();

    periodosOcupados.mockResolvedValue([]);
    const r = await sincronizar();

    expect(r.removidos).toBe(1);
    expect(await bloqueiosDoGoogle()).toHaveLength(0);
  });

  it("mover o compromisso move o bloqueio", async () => {
    periodosOcupados.mockResolvedValue([
      { eventId: "congresso-1", startsAt: amanha(14), endsAt: amanha(18) },
    ]);
    await sincronizar();

    periodosOcupados.mockResolvedValue([
      { eventId: "congresso-1", startsAt: amanha(9), endsAt: amanha(11) },
    ]);
    const r = await sincronizar();

    expect(r.criados).toBe(1);
    expect(r.removidos).toBe(1);
    const blocos = await bloqueiosDoGoogle();
    expect(blocos).toHaveLength(1);
    expect(blocos[0].startsAt.toISOString()).toBe(amanha(9).toISOString());
  });

  it("nunca encosta num bloqueio escrito pela recepção", async () => {
    const ferias = await prisma.block.create({
      data: {
        tenantId,
        doctorId,
        startsAt: amanha(8),
        endsAt: amanha(12),
        reason: "Férias do Dr. Google",
      },
    });

    periodosOcupados.mockResolvedValue([]);
    await sincronizar();

    expect(await prisma.block.findUnique({ where: { id: ferias.id } })).not.toBeNull();
  });
});
