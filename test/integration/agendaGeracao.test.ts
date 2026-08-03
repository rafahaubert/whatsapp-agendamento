import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { prisma } from "../../src/db/client.js";
import { seedClinic, regenerateSlots } from "../../src/db/seed.js";
import { sincronizarFeriados, PREFIXO_FERIADO } from "../../src/jobs/feriados.js";
import { SlotStatus } from "../../src/shared/enums.js";
import type { ClinicFile, TenantConfig } from "../../src/config/types.js";

const TZ = "America/Sao_Paulo";

const clinicFile: ClinicFile = {
  slug: "clinica-geracao",
  name: "Clínica Geração",
  whatsappPhoneNumberId: "test-geracao-000",
  timezone: TZ,
  config: {
    branding: {
      clinicName: "Clínica Geração",
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
    },
    ai: { model: "claude-haiku-4-5", persona: "Objetivo." },
  },
  catalog: {
    units: [{ name: "Unidade Central" }],
    // Duas especialidades no MESMO profissional: é aqui que a duração única doía.
    specialties: ["Limpeza", "Canal"],
    insurers: [],
    doctors: [
      { name: "Dr. Longo", specialties: ["Limpeza", "Canal"], units: ["Unidade Central"] },
    ],
  },
};

let tenantId = "";
let config: TenantConfig;

/** Minutos de duração de cada slot de uma especialidade. */
async function duracoesDe(nomeEspecialidade: string): Promise<number[]> {
  const spec = await prisma.specialty.findFirstOrThrow({
    where: { tenantId, name: nomeEspecialidade },
  });
  const slots = await prisma.slot.findMany({
    where: { tenantId, specialtyId: spec.id, status: SlotStatus.AVAILABLE },
    orderBy: { startsAt: "asc" },
    take: 50,
  });
  return slots.map((s) => Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000));
}

/** Início dos slots de uma especialidade, em ordem. */
async function iniciosDe(nomeEspecialidade: string): Promise<Date[]> {
  const spec = await prisma.specialty.findFirstOrThrow({
    where: { tenantId, name: nomeEspecialidade },
  });
  const slots = await prisma.slot.findMany({
    where: { tenantId, specialtyId: spec.id, status: SlotStatus.AVAILABLE },
    orderBy: { startsAt: "asc" },
    take: 50,
  });
  return slots.map((s) => s.startsAt);
}

async function regerar(): Promise<void> {
  await regenerateSlots(prisma, { tenantId, timezone: TZ, config, slotDays: 3 });
}

beforeAll(async () => {
  const r = await seedClinic(prisma, clinicFile, { slotDays: 3 });
  tenantId = r.tenantId;
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  config = JSON.parse(t.config) as TenantConfig;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("duração por procedimento (integração)", () => {
  // REGRESSÃO: havia UM `slotDurationMinutes` global. Uma limpeza de 15 minutos
  // e um canal de 90 ocupavam exatamente o mesmo slot — ou se perdia agenda no
  // curto, ou se atrasava o dia inteiro no longo.
  it("cada especialidade gera slots com a SUA duração", async () => {
    await prisma.specialty.updateMany({
      where: { tenantId, name: "Limpeza" },
      data: { durationMinutes: 15 },
    });
    await prisma.specialty.updateMany({
      where: { tenantId, name: "Canal" },
      data: { durationMinutes: 90 },
    });

    await regerar();

    const limpeza = await duracoesDe("Limpeza");
    const canal = await duracoesDe("Canal");

    expect(limpeza.length).toBeGreaterThan(0);
    expect(canal.length).toBeGreaterThan(0);
    expect(new Set(limpeza)).toEqual(new Set([15]));
    expect(new Set(canal)).toEqual(new Set([90]));
  });

  it("quem não define duração herda o padrão da clínica", async () => {
    await prisma.specialty.updateMany({
      where: { tenantId, name: "Limpeza" },
      data: { durationMinutes: null },
    });
    await regerar();
    expect(new Set(await duracoesDe("Limpeza"))).toEqual(new Set([30]));
  });

  // REGRESSÃO: o teste era só sobre o INÍCIO do slot. Um procedimento de 90
  // minutos começando às 17h gerava um horário terminando às 18h30 — meia hora
  // depois de a clínica fechar. Com 30 minutos fixos isso nunca aparecia,
  // porque a duração dividia o expediente certinho.
  it("nenhum horário passa do fechamento", async () => {
    await prisma.specialty.updateMany({
      where: { tenantId, name: "Canal" },
      data: { durationMinutes: 90 },
    });
    await regerar();

    const spec = await prisma.specialty.findFirstOrThrow({ where: { tenantId, name: "Canal" } });
    const slots = await prisma.slot.findMany({
      where: { tenantId, specialtyId: spec.id, status: SlotStatus.AVAILABLE },
    });
    expect(slots.length).toBeGreaterThan(0);

    for (const s of slots) {
      const fim = DateTime.fromJSDate(s.endsAt).setZone(TZ);
      const fechamento = fim.startOf("day").set({ hour: 18, minute: 0 });
      expect(fim.toMillis(), `slot terminando ${fim.toISO()}`).toBeLessThanOrEqual(
        fechamento.toMillis(),
      );
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("intervalo entre consultas (integração)", () => {
  it("sem intervalo, um horário começa quando o anterior termina", async () => {
    config.booking.bufferMinutes = 0;
    await prisma.specialty.updateMany({
      where: { tenantId, name: "Limpeza" },
      data: { durationMinutes: 30 },
    });
    await regerar();

    const inicios = await iniciosDe("Limpeza");
    const passo = inicios[1].getTime() - inicios[0].getTime();
    expect(passo).toBe(30 * 60_000);
  });

  // A folga para higienizar a sala e anotar o prontuário. Sem ela, o atraso da
  // manhã inteira nasce da primeira consulta que passa cinco minutos do previsto.
  it("com intervalo, entra a folga entre um horário e o seguinte", async () => {
    config.booking.bufferMinutes = 15;
    await regerar();

    const inicios = await iniciosDe("Limpeza");
    const passo = inicios[1].getTime() - inicios[0].getTime();
    expect(passo).toBe(45 * 60_000); // 30 de consulta + 15 de folga

    config.booking.bufferMinutes = 0; // não vaza para os outros casos
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("feriados nacionais (integração)", () => {
  it("desligado, não cria bloqueio nenhum", async () => {
    config.booking.feriadosNacionais = { enabled: false, incluirFacultativos: true };
    const r = await sincronizarFeriados({ id: tenantId, slug: "x", timezone: TZ }, config);
    expect(r.criados).toBe(0);

    const blocos = await prisma.block.findMany({
      where: { tenantId, reason: { startsWith: PREFIXO_FERIADO } },
    });
    expect(blocos).toHaveLength(0);
  });

  it("ligado, fecha a agenda no feriado", async () => {
    config.booking.feriadosNacionais = { enabled: true, incluirFacultativos: true };
    // 10/02/2026 + 15 dias alcança o Carnaval (16 e 17/02).
    const r = await sincronizarFeriados(
      { id: tenantId, slug: "x", timezone: TZ },
      { ...config, booking: { ...config.booking, advanceBookingDays: 15 } },
      new Date("2026-02-10T12:00:00Z"),
    );
    expect(r.criados).toBe(2);

    const blocos = await prisma.block.findMany({
      where: { tenantId, reason: { startsWith: PREFIXO_FERIADO } },
      orderBy: { startsAt: "asc" },
    });
    expect(blocos.map((b) => b.reason)).toEqual([
      `${PREFIXO_FERIADO}Carnaval (segunda)`,
      `${PREFIXO_FERIADO}Carnaval (terça)`,
    ]);
    // Feriado fecha a clínica inteira, não um profissional.
    expect(blocos.every((b) => b.doctorId === null)).toBe(true);
  });

  it("rodar de novo não duplica", async () => {
    const janela = { ...config, booking: { ...config.booking, advanceBookingDays: 15 } };
    const r = await sincronizarFeriados(
      { id: tenantId, slug: "x", timezone: TZ },
      janela,
      new Date("2026-02-10T12:00:00Z"),
    );
    expect(r.criados).toBe(0);
    expect(r.removidos).toBe(0);

    const blocos = await prisma.block.findMany({
      where: { tenantId, reason: { startsWith: PREFIXO_FERIADO } },
    });
    expect(blocos).toHaveLength(2);
  });

  // Sem a reconciliação para trás, desligar o recurso (ou tirar os facultativos)
  // deixaria a clínica fechada num dia útil para sempre.
  it("tirar os facultativos devolve o Carnaval à agenda", async () => {
    const janela = {
      ...config,
      booking: {
        ...config.booking,
        advanceBookingDays: 15,
        feriadosNacionais: { enabled: true, incluirFacultativos: false },
      },
    };
    const r = await sincronizarFeriados(
      { id: tenantId, slug: "x", timezone: TZ },
      janela,
      new Date("2026-02-10T12:00:00Z"),
    );
    expect(r.removidos).toBe(2);

    const blocos = await prisma.block.findMany({
      where: { tenantId, reason: { startsWith: PREFIXO_FERIADO } },
    });
    expect(blocos).toHaveLength(0);
  });

  it("nunca encosta num bloqueio escrito pela recepção", async () => {
    const ferias = await prisma.block.create({
      data: {
        tenantId,
        doctorId: null,
        startsAt: new Date("2026-02-16T03:00:00Z"),
        endsAt: new Date("2026-02-18T02:59:59Z"),
        reason: "Dra. Ana de férias",
      },
    });

    const janela = {
      ...config,
      booking: {
        ...config.booking,
        advanceBookingDays: 15,
        feriadosNacionais: { enabled: false, incluirFacultativos: false },
      },
    };
    await sincronizarFeriados(
      { id: tenantId, slug: "x", timezone: TZ },
      janela,
      new Date("2026-02-10T12:00:00Z"),
    );

    const aindaLa = await prisma.block.findUnique({ where: { id: ferias.id } });
    expect(aindaLa).not.toBeNull();
    await prisma.block.delete({ where: { id: ferias.id } });
  });
});
