import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { seedClinic } from "../../src/db/seed.js";
import * as scheduling from "../../src/domain/scheduling.js";
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

  // "Na quarta, teria?" — antes o dia pedido era ignorado e o agente respondia
  // com os horários mais próximos (de outro dia), concluindo que não havia vaga.
  describe("filtro por dia", () => {
    /** "29/07" — como o paciente escreve, no fuso da clínica. */
    const emDias = (n: number) =>
      new Intl.DateTimeFormat("pt-BR", {
        timeZone: tenant.timezone,
        day: "2-digit",
        month: "2-digit",
      }).format(new Date(Date.now() + n * 86_400_000));

    it("devolve apenas horários do dia pedido", async () => {
      const amanha = emDias(1);
      const r = (await scheduling.listAvailableSlots(tenant, {
        especialidade: "Clínico Geral",
        dia: "amanhã",
      })) as { horarios: { inicio: string }[]; dia?: string };

      expect(r.horarios.length).toBeGreaterThan(0);
      expect(r.dia).toContain(amanha);
      r.horarios.forEach((h) => expect(h.inicio).toContain(amanha));
    });

    it("aceita a data escrita pelo paciente", async () => {
      const r = (await scheduling.listAvailableSlots(tenant, {
        especialidade: "Clínico Geral",
        dia: emDias(1),
      })) as { horarios: { inicio: string }[] };
      expect(r.horarios.length).toBeGreaterThan(0);
      r.horarios.forEach((h) => expect(h.inicio).toContain(emDias(1)));
    });

    it("nome de dia da semana nunca traz horário de outro dia", async () => {
      const abrev: Record<string, string> = {
        domingo: "dom",
        segunda: "seg",
        terça: "ter",
        quarta: "qua",
        quinta: "qui",
        sexta: "sex",
        sábado: "sáb",
      };
      for (const [nome, prefixo] of Object.entries(abrev)) {
        const r = (await scheduling.listAvailableSlots(tenant, {
          especialidade: "Clínico Geral",
          dia: nome,
        })) as { horarios: { inicio: string }[] };
        r.horarios.forEach((h) => expect(h.inicio.startsWith(prefixo)).toBe(true));
      }
    });

    it("dia sem vaga volta vazio e sugere os dias que têm", async () => {
      // A agenda de teste cobre 3 dias; o dia +10 existe, mas sem horários.
      const r = (await scheduling.listAvailableSlots(tenant, {
        especialidade: "Clínico Geral",
        dia: emDias(10),
      })) as { horarios: unknown[]; aviso?: string; proximasDatas?: string[] };

      expect(r.horarios).toHaveLength(0);
      expect(r.aviso).toContain(emDias(10));
      expect(r.proximasDatas?.length).toBeGreaterThan(0);
    });

    it("avisa quando o dia está além da janela de agendamento", async () => {
      const r = (await scheduling.listAvailableSlots(tenant, {
        especialidade: "Clínico Geral",
        dia: emDias(40), // advanceBookingDays = 30
      })) as { horarios: unknown[]; aviso?: string };

      expect(r.horarios).toHaveLength(0);
      expect(r.aviso).toContain("agenda");
    });

    it("devolve erro quando não entende o dia", async () => {
      const r = (await scheduling.listAvailableSlots(tenant, {
        especialidade: "Clínico Geral",
        dia: "qualquer dia desses",
      })) as { erro?: string };
      expect(r.erro).toBeDefined();
    });
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
