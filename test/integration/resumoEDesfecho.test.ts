import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { DateTime } from "luxon";
import { prisma } from "../../src/db/client.js";
import { seedClinic } from "../../src/db/seed.js";
import { AppointmentStatus, SlotStatus } from "../../src/shared/enums.js";
import type { ClinicFile, TenantConfig } from "../../src/config/types.js";

/**
 * Estes testes cobrem os INVÓLUCROS dos jobs — as funções que leem o banco e
 * decidem —, e não as regras puras (`deveEnviarResumo`, `podePerguntar`), que já
 * têm teste próprio em test/unit. A distinção importa: a regra pura pode estar
 * perfeita e a query, errada. `apurarDesfechos` escreve COMPLETED EM MASSA, e
 * `apurarResumo` monta os números que vão para o WhatsApp do dono da clínica.
 */
/** Assinatura real de `sendWhatsAppButtons`, para o mock não perder o tipo. */
type EnviarBotoes = (
  phoneNumberId: string,
  to: string,
  texto: string,
  opcoes: { id: string; titulo: string }[],
) => Promise<void>;

const enviarBotoes = vi.fn<EnviarBotoes>(async () => undefined);
vi.mock("../../src/channels/whatsapp/client.js", () => ({
  sendWhatsAppButtons: (...a: Parameters<EnviarBotoes>) => enviarBotoes(...a),
  sendWhatsAppTemplate: vi.fn(async () => undefined),
  sendWhatsAppText: vi.fn(async () => undefined),
  sendWhatsAppList: vi.fn(async () => undefined),
}));

const { apurarResumo } = await import("../../src/jobs/resumoDiario.js");
const { apurarDesfechos } = await import("../../src/jobs/desfecho.js");
const { limparCacheDeConfig } = await import("../../src/jobs/janela.js");

const TZ = "America/Sao_Paulo"; // UTC-3

const clinicFile: ClinicFile = {
  slug: "clinica-jobs",
  name: "Clínica Jobs",
  whatsappPhoneNumberId: "test-jobs-000",
  timezone: TZ,
  config: {
    branding: {
      clinicName: "Clínica Jobs",
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
    outcome: { enabled: true, horasAposConsulta: 3, diasParaPresumir: 3 },
  },
  catalog: {
    units: [{ name: "Unidade Central" }],
    specialties: ["Clínico Geral"],
    insurers: [],
    doctors: [{ name: "Dra. Ana", specialties: ["Clínico Geral"], units: ["Unidade Central"] }],
  },
};

let tenantId = "";
let unitId = "";
let doctorId = "";
let specialtyId = "";
let patientId = "";

/**
 * "Agora" fixo: quarta-feira, 12/08/2026, 14:00 no fuso da clínica.
 *
 * Fixo de propósito. A hora importa em três lugares (a virada do dia da
 * clínica, a janela de envio de 8h–20h e o corte de horários livres "daqui para
 * a frente"), e um `new Date()` faria o teste passar ou falhar conforme a hora
 * em que o CI rodasse.
 */
const AGORA = DateTime.fromISO("2026-08-12T14:00:00", { zone: TZ }).toJSDate();

/** Um instante no fuso da clínica, com deslocamento em dias. */
function local(dias: number, hora: number, minuto = 0): Date {
  return DateTime.fromJSDate(AGORA)
    .setZone(TZ)
    .startOf("day")
    .plus({ days: dias })
    .set({ hour: hora, minute: minuto })
    .toJSDate();
}

/** Cria um horário livre. */
async function criarSlot(inicio: Date, status: string = SlotStatus.AVAILABLE) {
  return prisma.slot.create({
    data: {
      tenantId,
      unitId,
      doctorId,
      specialtyId,
      startsAt: inicio,
      endsAt: new Date(inicio.getTime() + 30 * 60_000),
      status,
    },
  });
}

/** Cria uma consulta num horário novo. */
async function criarConsulta(inicio: Date, status: string) {
  const slot = await criarSlot(inicio, SlotStatus.BOOKED);
  return prisma.appointment.create({
    data: {
      tenantId,
      unitId,
      patientId,
      doctorId,
      specialtyId,
      slotId: slot.id,
      status,
    },
  });
}

beforeAll(async () => {
  const r = await seedClinic(prisma, clinicFile, { slotDays: 0 });
  tenantId = r.tenantId;
  unitId = (await prisma.unit.findFirstOrThrow({ where: { tenantId } })).id;
  doctorId = (await prisma.doctor.findFirstOrThrow({ where: { tenantId } })).id;
  specialtyId = (await prisma.specialty.findFirstOrThrow({ where: { tenantId } })).id;
  const p = await prisma.patient.create({
    data: { tenantId, name: "Paciente Jobs", cpf: "12345678909", phone: "+5551988887777" },
  });
  patientId = p.id;
});

beforeEach(async () => {
  enviarBotoes.mockClear();
  limparCacheDeConfig();
  // O seed gera horários; cada caso monta exatamente o que precisa.
  await prisma.appointment.deleteMany({ where: { tenantId } });
  await prisma.slot.deleteMany({ where: { tenantId } });
  await prisma.message.deleteMany({ where: { tenantId } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("apurarResumo (integração)", () => {
  it("conta a agenda de hoje e as faltas de ontem", async () => {
    await criarConsulta(local(0, 9), AppointmentStatus.SCHEDULED);
    await criarConsulta(local(0, 10), AppointmentStatus.CONFIRMED);
    await criarConsulta(local(0, 11), AppointmentStatus.CONFIRMED);
    await criarConsulta(local(-1, 9), AppointmentStatus.NO_SHOW);
    await criarSlot(local(0, 16));
    await criarSlot(local(0, 17));

    const r = await apurarResumo(tenantId, TZ, AGORA);

    expect(r.consultasHoje).toBe(3);
    expect(r.confirmadasHoje).toBe(2);
    expect(r.faltasOntem).toBe(1);
    expect(r.horariosLivresHoje).toBe(2);
  });

  // Anunciar como vaga um horário que já passou faria o dono cobrar a recepção
  // por algo que ninguém podia vender.
  it("horário livre que já passou não conta como vaga", async () => {
    await criarSlot(local(0, 9)); // manhã: já passou às 14h
    await criarSlot(local(0, 16)); // à tarde: ainda dá

    const r = await apurarResumo(tenantId, TZ, AGORA);
    expect(r.horariosLivresHoje).toBe(1);
  });

  it("consulta cancelada não entra na agenda do dia", async () => {
    await criarConsulta(local(0, 9), AppointmentStatus.SCHEDULED);
    await criarConsulta(local(0, 10), AppointmentStatus.CANCELLED);

    const r = await apurarResumo(tenantId, TZ, AGORA);
    expect(r.consultasHoje).toBe(1);
  });

  it("não mistura o dia de hoje com o de amanhã nem com o de ontem", async () => {
    await criarConsulta(local(-1, 15), AppointmentStatus.SCHEDULED);
    await criarConsulta(local(0, 15), AppointmentStatus.SCHEDULED);
    await criarConsulta(local(1, 15), AppointmentStatus.SCHEDULED);

    const r = await apurarResumo(tenantId, TZ, AGORA);
    expect(r.consultasHoje).toBe(1);
  });

  // A virada do dia é a da CLÍNICA. Uma consulta às 22h em São Paulo já é o dia
  // seguinte em UTC — contar no fuso errado moveria consultas de dia.
  it("a virada do dia é a da clínica, não a do servidor", async () => {
    await criarConsulta(local(0, 22), AppointmentStatus.SCHEDULED); // 01:00Z de amanhã
    await criarConsulta(local(0, 1), AppointmentStatus.SCHEDULED); // 04:00Z de hoje

    const r = await apurarResumo(tenantId, TZ, AGORA);
    expect(r.consultasHoje).toBe(2);
  });

  it("faltas de ontem, não as de hoje", async () => {
    await criarConsulta(local(-1, 9), AppointmentStatus.NO_SHOW);
    await criarConsulta(local(0, 9), AppointmentStatus.NO_SHOW);
    await criarConsulta(local(-2, 9), AppointmentStatus.NO_SHOW);

    const r = await apurarResumo(tenantId, TZ, AGORA);
    expect(r.faltasOntem).toBe(1);
  });

  it("dia vazio devolve zeros, não erro", async () => {
    const r = await apurarResumo(tenantId, TZ, AGORA);
    expect(r).toEqual({
      consultasHoje: 0,
      confirmadasHoje: 0,
      horariosLivresHoje: 0,
      faltasOntem: 0,
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("apurarDesfechos (integração)", () => {
  /** Reescreve a config da clínica no banco (o job a lê de lá). */
  async function configurar(outcome: TenantConfig["outcome"]) {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const cfg = JSON.parse(t.config) as TenantConfig;
    cfg.outcome = outcome;
    await prisma.tenant.update({ where: { id: tenantId }, data: { config: JSON.stringify(cfg) } });
    limparCacheDeConfig();
  }

  it("presume comparecimento no silêncio longo", async () => {
    const a = await criarConsulta(local(-5, 9), AppointmentStatus.SCHEDULED);

    const r = await apurarDesfechos(AGORA);
    expect(r.presumidos).toBe(1);

    const depois = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois.status).toBe(AppointmentStatus.COMPLETED);
    // Presunção fica MARCADA: o painel não vende estimativa como fato apurado.
    expect(depois.outcomeAuto).toBe(true);
  });

  it("não presume antes do prazo", async () => {
    const a = await criarConsulta(local(-1, 9), AppointmentStatus.SCHEDULED);

    const r = await apurarDesfechos(AGORA);
    expect(r.presumidos).toBe(0);

    const depois = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois.status).toBe(AppointmentStatus.SCHEDULED);
  });

  // Presumir por cima de um desfecho já apurado apagaria o trabalho da recepção
  // — e transformaria uma falta registrada em comparecimento.
  it("nunca mexe em quem já tem desfecho", async () => {
    const falta = await criarConsulta(local(-9, 9), AppointmentStatus.NO_SHOW);
    const feita = await criarConsulta(local(-9, 10), AppointmentStatus.COMPLETED);
    const cancelada = await criarConsulta(local(-9, 11), AppointmentStatus.CANCELLED);

    await apurarDesfechos(AGORA);

    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: falta.id } })).status).toBe(
      AppointmentStatus.NO_SHOW,
    );
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: feita.id } })).outcomeAuto).toBe(
      false,
    );
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: cancelada.id } })).status,
    ).toBe(AppointmentStatus.CANCELLED);
  });

  // A clínica que prefere um número menor porém apurado tem de conseguir
  // desligar a presunção — ela puxa a taxa de falta para baixo.
  it("prazo zero desliga a presunção", async () => {
    await configurar({ enabled: true, horasAposConsulta: 3, diasParaPresumir: 0 });
    const a = await criarConsulta(local(-30, 9), AppointmentStatus.SCHEDULED);

    const r = await apurarDesfechos(AGORA);
    expect(r.presumidos).toBe(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      AppointmentStatus.SCHEDULED,
    );

    await configurar({ enabled: true, horasAposConsulta: 3, diasParaPresumir: 3 });
  });

  it("recurso desligado não escreve nada", async () => {
    await configurar({ enabled: false, horasAposConsulta: 3, diasParaPresumir: 3 });
    const a = await criarConsulta(local(-30, 9), AppointmentStatus.SCHEDULED);

    const r = await apurarDesfechos(AGORA);
    expect(r).toEqual({ perguntados: 0, presumidos: 0 });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      AppointmentStatus.SCHEDULED,
    );

    await configurar({ enabled: true, horasAposConsulta: 3, diasParaPresumir: 3 });
  });

  it("pergunta ao paciente que escreveu dentro da janela da Meta", async () => {
    const a = await criarConsulta(local(0, 9), AppointmentStatus.SCHEDULED);
    // Escreveu há duas horas: a janela de 24h está aberta, a mensagem é livre.
    await prisma.message.create({
      data: {
        tenantId,
        phone: "+5551988887777",
        direction: "IN",
        text: "obrigado!",
        createdAt: new Date(AGORA.getTime() - 2 * 3_600_000),
      },
    });

    const r = await apurarDesfechos(AGORA);

    expect(r.perguntados).toBe(1);
    expect(enviarBotoes).toHaveBeenCalledTimes(1);
    // Os payloads dos botões são o contrato com o motor (ACOES_VALIDAS em
    // src/core/engine.ts): errar o prefixo faz o toque do paciente virar
    // "payload inválido" e o desfecho nunca ser registrado.
    const [, , , opcoes] = enviarBotoes.mock.calls[0];
    expect(opcoes.map((o) => o.id)).toEqual([`VEIO:${a.id}`, `FALTEI:${a.id}`]);

    // A marca impede perguntar de novo no ciclo seguinte.
    const depois = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois.outcomeAskedAt).not.toBeNull();
  });

  // Fora da janela, a mensagem livre é recusada pela Meta e perguntar custaria
  // um template — que é exatamente o que este job existe para evitar.
  it("não pergunta a quem está fora da janela da Meta", async () => {
    await criarConsulta(local(0, 9), AppointmentStatus.SCHEDULED);
    await prisma.message.create({
      data: {
        tenantId,
        phone: "+5551988887777",
        direction: "IN",
        text: "oi",
        createdAt: new Date(AGORA.getTime() - 30 * 3_600_000),
      },
    });

    const r = await apurarDesfechos(AGORA);
    expect(r.perguntados).toBe(0);
    expect(enviarBotoes).not.toHaveBeenCalled();
  });

  it("não pergunta duas vezes", async () => {
    const a = await criarConsulta(local(0, 9), AppointmentStatus.SCHEDULED);
    await prisma.appointment.update({
      where: { id: a.id },
      data: { outcomeAskedAt: new Date(AGORA.getTime() - 3_600_000) },
    });
    await prisma.message.create({
      data: {
        tenantId,
        phone: "+5551988887777",
        direction: "IN",
        text: "oi",
        createdAt: new Date(AGORA.getTime() - 3_600_000),
      },
    });

    const r = await apurarDesfechos(AGORA);
    expect(r.perguntados).toBe(0);
    expect(enviarBotoes).not.toHaveBeenCalled();
  });

  // Perguntar às três da manhã transforma cuidado em incômodo.
  it("respeita a janela de envio da clínica", async () => {
    await criarConsulta(local(0, 1), AppointmentStatus.SCHEDULED);
    const madrugada = DateTime.fromISO("2026-08-12T05:00:00", { zone: TZ }).toJSDate();
    await prisma.message.create({
      data: {
        tenantId,
        phone: "+5551988887777",
        direction: "IN",
        text: "oi",
        createdAt: new Date(madrugada.getTime() - 3_600_000),
      },
    });

    const r = await apurarDesfechos(madrugada);
    expect(r.perguntados).toBe(0);
    expect(enviarBotoes).not.toHaveBeenCalled();
  });
});
