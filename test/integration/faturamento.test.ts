import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { seedClinic } from "../../src/db/seed.js";
import { calcularMetricas } from "../../src/admin/metrics.js";
import * as scheduling from "../../src/domain/scheduling.js";
import { AppointmentStatus, SlotStatus } from "../../src/shared/enums.js";
import type { ResolvedTenant } from "../../src/db/tenantRepository.js";
import type { ClinicFile } from "../../src/config/types.js";

const TZ = "America/Sao_Paulo";

const clinicFile: ClinicFile = {
  slug: "clinica-faturamento",
  name: "Clínica Faturamento",
  whatsappPhoneNumberId: "test-fat-000",
  timezone: TZ,
  config: {
    branding: {
      clinicName: "Clínica Faturamento",
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
    specialties: ["Limpeza", "Canal"],
    insurers: [],
    doctors: [{ name: "Dra. Bia", specialties: ["Limpeza", "Canal"], units: ["Unidade Central"] }],
  },
};

let tenant: ResolvedTenant;
const CPFS = ["12345678909", "13456790090", "14567901100"];

async function agendar(cpf: string, nome: string, especialidade: string) {
  const p = (await scheduling.findOrCreatePatient(tenant.id, {
    nome,
    cpf,
    phone: `+551190000${cpf.slice(0, 4)}`,
  })) as { patientId: string };

  const spec = await prisma.specialty.findFirstOrThrow({
    where: { tenantId: tenant.id, name: especialidade },
  });

  // A mesma profissional atende as duas especialidades, então os horários das
  // duas se cruzam na agenda dela: pegar sempre o primeiro livre esbarraria na
  // trava de conflito do profissional (que está certa). Anda até achar um que
  // realmente caiba.
  const candidatos = await prisma.slot.findMany({
    where: { tenantId: tenant.id, specialtyId: spec.id, status: SlotStatus.AVAILABLE },
    orderBy: { startsAt: "asc" },
    take: 40,
  });

  let ultimoErro = "sem horários livres";
  for (const slot of candidatos) {
    const r = (await scheduling.bookAppointment(tenant, p.patientId, slot.id, "PARTICULAR")) as {
      appointmentId?: string;
      erro?: string;
    };
    if (r.appointmentId) return r.appointmentId;
    ultimoErro = r.erro ?? ultimoErro;
  }
  throw new Error(`falha ao agendar ${especialidade}: ${ultimoErro}`);
}

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

  // Limpeza a R$ 150; Canal sem preço cadastrado, de propósito.
  await prisma.specialty.updateMany({
    where: { tenantId: tenant.id, name: "Limpeza" },
    data: { priceCents: 15000 },
  });
  await prisma.specialty.updateMany({
    where: { tenantId: tenant.id, name: "Canal" },
    data: { priceCents: null },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("faturamento e ocupação (integração)", () => {
  it("separa o que foi faturado do que está agendado a receber", async () => {
    const realizada = await agendar(CPFS[0], "Ana Realizada", "Limpeza");
    await agendar(CPFS[1], "Bruno Agendado", "Limpeza");

    await prisma.appointment.update({
      where: { id: realizada },
      data: { status: AppointmentStatus.COMPLETED },
    });

    const m = await calcularMetricas(tenant.id, tenant.config, TZ, 30);

    expect(m.faturamentoCentavos).toBe(15000); // só a realizada
    expect(m.faturamentoPrevistoCentavos).toBe(15000); // só a agendada
    expect(m.faturamentoPorEspecialidade).toEqual([
      { especialidade: "Limpeza", centavos: 15000, consultas: 1 },
    ]);
  });

  // Sem este aviso, a clínica leria o total como se fosse tudo o que ela fatura.
  it("conta à parte a consulta sem preço cadastrado", async () => {
    await agendar(CPFS[2], "Carla SemPreco", "Canal");

    const m = await calcularMetricas(tenant.id, tenant.config, TZ, 30);
    expect(m.consultasSemPreco).toBe(1);
    // E não somou zero escondido no total.
    expect(m.faturamentoCentavos).toBe(15000);
  });

  it("mede a ocupação da agenda à frente", async () => {
    const m = await calcularMetricas(tenant.id, tenant.config, TZ, 30);

    expect(m.ocupacaoAdiante).not.toBeNull();
    expect(m.ocupacaoAdiante!).toBeGreaterThan(0);
    expect(m.ocupacaoAdiante!).toBeLessThan(100);
    expect(m.horariosLivresAdiante).toBeGreaterThan(0);
    // A janela à frente nunca passa da janela de agendamento da clínica.
    expect(m.diasAdiante).toBeLessThanOrEqual(tenant.config.booking.advanceBookingDays);
  });
});
