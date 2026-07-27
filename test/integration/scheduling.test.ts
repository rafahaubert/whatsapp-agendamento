import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { prisma } from "../../src/db/client.js";
import { seedClinic } from "../../src/db/seed.js";
import * as scheduling from "../../src/domain/scheduling.js";
import { executeTool } from "../../src/ai/tools.js";
import { SlotStatus } from "../../src/shared/enums.js";
import type { ResolvedTenant } from "../../src/db/tenantRepository.js";
import type { ClinicFile } from "../../src/config/types.js";

// Clínica mínima com todos os dias abertos, para sempre haver horários.
const clinicFile: ClinicFile = {
  slug: "clinica-teste",
  name: "Clínica Teste",
  whatsappPhoneNumberId: "test-000",
  timezone: "America/Sao_Paulo",
  config: {
    branding: {
      clinicName: "Clínica Teste",
      greetingMessage: "Olá!",
      fallbackMessage: "Não entendi.",
      closingMessage: "Até breve!",
    },
    businessHours: {
      timezone: "America/Sao_Paulo",
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
    ai: { model: "claude-haiku-4-5", persona: "teste" },
  },
  catalog: {
    units: [{ name: "Unidade Central" }],
    specialties: ["Clínico Geral"],
    insurers: [],
    doctors: [{ name: "Dr. Teste", specialties: ["Clínico Geral"], units: ["Unidade Central"] }],
  },
};

// CPF de teste válido (dígitos verificadores corretos).
const CPF = "529.982.247-25";

let tenant: ResolvedTenant;

beforeAll(async () => {
  const r = await seedClinic(prisma, clinicFile, { slotDays: 3 });
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: r.tenantId } });
  tenant = {
    id: t.id,
    slug: t.slug,
    name: t.name,
    timezone: t.timezone,
    whatsappPhoneNumberId: t.whatsappPhoneNumberId,
    config: JSON.parse(t.config),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Só roda com um Postgres de teste configurado (ver test/integration/setup.ts).
describe.skipIf(!process.env.TEST_DATABASE_URL)("scheduling (integração)", () => {
  it("oferece no máximo maxOptionsOffered horários", async () => {
    const r = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: unknown[];
    };
    expect(r.horarios.length).toBeGreaterThan(0);
    expect(r.horarios.length).toBeLessThanOrEqual(tenant.config.booking.maxOptionsOffered);
  });

  it("agenda e impede reserva dupla no mesmo horário", async () => {
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Fulano de Tal",
      cpf: CPF,
      phone: "+5511999990000",
    })) as { patientId: string };

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    const slotId = slots.horarios[0].slotId;

    const ok = (await scheduling.bookAppointment(tenant, p.patientId, slotId, "PARTICULAR")) as {
      status?: string;
    };
    expect(ok.status).toBe("AGENDADO");

    const dupe = (await scheduling.bookAppointment(tenant, p.patientId, slotId, "PARTICULAR")) as {
      erro?: string;
    };
    expect(dupe.erro).toBeDefined();
  });

  it("REGRESSÃO: horário pedido num dia específico sai naquele dia, e não em vários", async () => {
    const amanha = DateTime.now().setZone(tenant.timezone).plus({ days: 1 });

    const r = (await scheduling.listAvailableSlots(tenant, {
      especialidade: "Clínico Geral",
      dia: "amanhã",
      horaPreferida: "16:30",
    })) as { horarios: { inicio: string; slotId: string }[]; exato?: boolean; dia?: string };

    expect(r.exato).toBe(true);
    expect(r.horarios[0].inicio).toContain("16:30");

    // Todas as opções no MESMO dia (era isto que falhava: 16:00 em 3 dias diferentes).
    const dias = await prisma.slot.findMany({
      where: { id: { in: r.horarios.map((h) => h.slotId) } },
      select: { startsAt: true },
    });
    for (const s of dias) {
      const d = DateTime.fromJSDate(s.startsAt).setZone(tenant.timezone);
      expect(d.toISODate()).toBe(amanha.toISODate());
    }
  });

  it("avisa (sem inventar) quando o dia pedido não tem horário na agenda", async () => {
    // A agenda de teste só cobre 3 dias; 20 dias à frente não existe.
    const longe = DateTime.now().setZone(tenant.timezone).plus({ days: 20 });
    const r = (await scheduling.listAvailableSlots(tenant, {
      especialidade: "Clínico Geral",
      dia: longe.toFormat("dd/LL"),
    })) as { horarios: unknown[]; aviso?: string };

    expect(r.horarios).toEqual([]);
    expect(r.aviso).toBeDefined();
  });

  it("sem convênio cadastrado, listar_convenios explica em vez de vir vazio", async () => {
    const r = (await scheduling.listInsurers(tenant.id)) as {
      convenios: unknown[];
      aviso?: string;
    };
    expect(r.convenios).toEqual([]);
    expect(r.aviso).toMatch(/particular/i);
  });

  it("REGRESSÃO: a ferramenta agendar recusa enquanto o paciente não confirma", async () => {
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Antonio de Teste",
      cpf: "168.995.350-09",
      phone: "+5551976707700",
    })) as { patientId: string };

    const slots = (await scheduling.listAvailableSlots(tenant, {
      especialidade: "Clínico Geral",
      dia: "amanhã",
    })) as { horarios: { slotId: string }[] };
    const slotId = slots.horarios[0].slotId;

    const ctx = { tenant, phone: "+5551976707700", patientId: p.patientId };

    // Exatamente a conversa do print: pagamento + pergunta, sem nenhum "sim".
    const recusa = (await executeTool(
      "agendar",
      { slotId },
      { ...ctx, ultimaMensagemPaciente: "particular\nqual o valor?" },
    )) as { erro?: string };
    expect(recusa.erro).toMatch(/não confirmou/i);

    // O horário continua livre.
    expect((await prisma.slot.findUnique({ where: { id: slotId } }))?.status).toBe(
      SlotStatus.AVAILABLE,
    );

    // Com o "sim", agenda normalmente.
    const ok = (await executeTool(
      "agendar",
      { slotId },
      { ...ctx, ultimaMensagemPaciente: "sim, pode agendar" },
    )) as { status?: string };
    expect(ok.status).toBe("AGENDADO");
  });

  it("cancelar libera o horário", async () => {
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Fulano de Tal",
      cpf: CPF,
      phone: "+5511999990000",
    })) as { patientId: string };

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    const slotId = slots.horarios[0].slotId;

    const appt = (await scheduling.bookAppointment(tenant, p.patientId, slotId, "PARTICULAR")) as {
      appointmentId: string;
    };
    const cancel = (await scheduling.cancelAppointment(tenant, appt.appointmentId)) as {
      status?: string;
    };
    expect(cancel.status).toBe("CANCELADO");

    const slot = await prisma.slot.findUnique({ where: { id: slotId } });
    expect(slot?.status).toBe(SlotStatus.AVAILABLE);
  });
});
