import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "../../src/db/client.js";
import { seedClinic, regenerateSlots, chaveSlot } from "../../src/db/seed.js";
import * as scheduling from "../../src/domain/scheduling.js";
import { SlotStatus } from "../../src/shared/enums.js";
import type { ResolvedTenant } from "../../src/db/tenantRepository.js";
import type { ClinicFile } from "../../src/config/types.js";

// O envio à Meta é o único efeito externo destes fluxos. Fica mockado para os
// testes exercitarem a MÁQUINA DE ESTADOS da fila, que é o que quebrava.
vi.mock("../../src/channels/whatsapp/client.js", () => ({
  sendWhatsAppTemplate: vi.fn(async () => undefined),
  sendWhatsAppButtons: vi.fn(async () => undefined),
  sendWhatsAppText: vi.fn(async () => undefined),
  sendWhatsAppList: vi.fn(async () => undefined),
}));

const clinicFile: ClinicFile = {
  slug: "clinica-fila",
  name: "Clínica Fila",
  whatsappPhoneNumberId: "test-fila-000",
  timezone: "America/Sao_Paulo",
  config: {
    branding: {
      clinicName: "Clínica Fila",
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
    ai: { model: "claude-haiku-4-5", persona: "Objetivo." },
    // A fila só funciona com o recurso ligado e um template configurado.
    waitlist: { enabled: true, templateName: "vaga_disponivel", templateLang: "pt_BR" },
  },
  catalog: {
    units: [{ name: "Unidade Central" }],
    specialties: ["Clínico Geral"],
    insurers: [],
    doctors: [{ name: "Dra. Ana", specialties: ["Clínico Geral"], units: ["Unidade Central"] }],
  },
};

let tenant: ResolvedTenant;

/** CPFs válidos e distintos — o cadastro valida o dígito verificador. */
const CPFS = [
  "12345678909",
  "13456790090",
  "14567901100",
  "15679012200",
  "16790123393",
  "17901234458",
];

async function paciente(nome: string, cpf: string, phone: string): Promise<string> {
  const p = (await scheduling.findOrCreatePatient(tenant.id, { nome, cpf, phone })) as {
    patientId: string;
  };
  return p.patientId;
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("fila de espera (integração)", () => {
  // REGRESSÃO: avisar o primeiro da fila não segurava nada. Qualquer outro
  // paciente levava o horário antes de o convidado abrir o WhatsApp — e ele
  // chegava para descobrir que já era tarde.
  it("o horário oferecido fica reservado para o convidado", async () => {
    const convidado = await paciente("Convidada Um", CPFS[0], "+5511911110001");
    const intruso = await paciente("Intruso Dois", CPFS[1], "+5511911110002");
    const spec = await prisma.specialty.findFirstOrThrow({ where: { tenantId: tenant.id } });

    const slot = await prisma.slot.findFirstOrThrow({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE, reservedUntil: null },
      orderBy: { startsAt: "asc" },
    });

    await scheduling.entrarFilaEspera(tenant, convidado, spec.name);
    await scheduling.notificarFilaEspera(tenant, slot.id);

    const depois = await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(depois.reservedForPatientId).toBe(convidado);
    expect(depois.reservedUntil!.getTime()).toBeGreaterThan(Date.now());

    // O intruso é barrado…
    const barrado = (await scheduling.bookAppointment(tenant, intruso, slot.id, "PARTICULAR")) as {
      erro?: string;
    };
    expect(barrado.erro).toMatch(/reservado para outro paciente/i);

    // …e o convidado passa.
    const ok = (await scheduling.bookAppointment(tenant, convidado, slot.id, "PARTICULAR")) as {
      status?: string;
    };
    expect(ok.status).toBe("AGENDADO");

    // Conseguiu a consulta: sai da fila. O status DONE existia no schema desde
    // o começo e nunca era atribuído a ninguém.
    const inscricao = await prisma.waitlist.findFirstOrThrow({
      where: { tenantId: tenant.id, patientId: convidado, specialtyId: spec.id },
    });
    expect(inscricao.status).toBe("DONE");
  });

  it("o horário reservado some da vitrine — menos para o convidado", async () => {
    const convidado = await paciente("Convidada Tres", CPFS[2], "+5511911110003");
    const spec = await prisma.specialty.findFirstOrThrow({ where: { tenantId: tenant.id } });

    const slot = await prisma.slot.findFirstOrThrow({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE, reservedUntil: null },
      orderBy: { startsAt: "asc" },
    });
    await prisma.slot.update({
      where: { id: slot.id },
      data: {
        reservedUntil: new Date(Date.now() + 30 * 60_000),
        reservedForPatientId: convidado,
      },
    });

    const paraOutro = (await scheduling.listAvailableSlots(tenant, {
      especialidade: spec.name,
      pacienteId: "outro-qualquer",
    })) as { horarios: { slotId: string }[] };
    expect(paraOutro.horarios.map((h) => h.slotId)).not.toContain(slot.id);

    const paraEle = (await scheduling.listAvailableSlots(tenant, {
      especialidade: spec.name,
      pacienteId: convidado,
    })) as { horarios: { slotId: string }[] };
    expect(paraEle.horarios.map((h) => h.slotId)).toContain(slot.id);

    await prisma.slot.update({
      where: { id: slot.id },
      data: { reservedUntil: null, reservedForPatientId: null },
    });
  });

  // REGRESSÃO: quem não respondia virava NOTIFIED e ficava assim para sempre.
  // Ninguém mais era avisado e o horário voltava ao balcão sem a fila saber.
  it("oferta vencida passa a vez ao próximo da fila", async () => {
    const primeiro = await paciente("Primeiro Fila", CPFS[3], "+5511911110004");
    const segundo = await paciente("Segundo Fila", CPFS[4], "+5511911110005");
    const spec = await prisma.specialty.findFirstOrThrow({ where: { tenantId: tenant.id } });

    // Fila limpa para este caso.
    await prisma.waitlist.deleteMany({ where: { tenantId: tenant.id } });

    const slot = await prisma.slot.findFirstOrThrow({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE, reservedUntil: null },
      orderBy: { startsAt: "asc" },
    });

    await scheduling.entrarFilaEspera(tenant, primeiro, spec.name);
    await scheduling.entrarFilaEspera(tenant, segundo, spec.name);

    await scheduling.notificarFilaEspera(tenant, slot.id);
    const oferta1 = await prisma.waitlist.findFirstOrThrow({ where: { patientId: primeiro } });
    expect(oferta1.status).toBe("NOTIFIED");
    expect(oferta1.slotId).toBe(slot.id);

    // O convite vence sem resposta.
    const bemDepois = new Date(Date.now() + (scheduling.RESERVA_FILA_MINUTOS + 5) * 60_000);
    const r = await scheduling.expirarOfertasFilaEspera(tenant, bemDepois);
    expect(r.reofertados).toBe(1);

    // O primeiro volta para a fila com uma oferta perdida no currículo…
    const depois1 = await prisma.waitlist.findFirstOrThrow({ where: { patientId: primeiro } });
    expect(depois1.status).toBe("ACTIVE");
    expect(depois1.ofertasPerdidas).toBe(1);

    // …e o SEGUNDO é quem recebe o convite agora. Este é o ponto todo.
    const depois2 = await prisma.waitlist.findFirstOrThrow({ where: { patientId: segundo } });
    expect(depois2.status).toBe("NOTIFIED");
    expect(depois2.slotId).toBe(slot.id);

    const reservado = await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(reservado.reservedForPatientId).toBe(segundo);
  });

  it("quem ignora ofertas demais sai da fila", async () => {
    const teimoso = await paciente("Teimoso Silva", CPFS[5], "+5511911110006");
    const spec = await prisma.specialty.findFirstOrThrow({ where: { tenantId: tenant.id } });

    await prisma.waitlist.deleteMany({ where: { tenantId: tenant.id } });
    await scheduling.entrarFilaEspera(tenant, teimoso, spec.name);

    // Já deixou passar o limite menos uma; a próxima encerra a inscrição.
    await prisma.waitlist.updateMany({
      where: { patientId: teimoso },
      data: {
        status: "NOTIFIED",
        notifiedAt: new Date(0),
        ofertasPerdidas: scheduling.MAX_OFERTAS_PERDIDAS - 1,
      },
    });

    await scheduling.expirarOfertasFilaEspera(tenant, new Date());

    const fim = await prisma.waitlist.findFirstOrThrow({ where: { patientId: teimoso } });
    expect(fim.status).toBe("DONE");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("renovação da agenda (integração)", () => {
  // REGRESSÃO: a renovação diária apagava todos os horários livres e recriava
  // tudo com id novo. O botão "SLOT:<id>" do convite da fila — e qualquer lista
  // de horários que o paciente ainda não tivesse tocado — dava "Horário não
  // encontrado" no dia seguinte, sem ele ter feito nada de errado.
  it("preserva o id do horário que continua na agenda", async () => {
    const antes = await prisma.slot.findMany({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE },
      select: { id: true, doctorId: true, unitId: true, specialtyId: true, startsAt: true, endsAt: true },
    });
    expect(antes.length).toBeGreaterThan(0);

    await regenerateSlots(prisma, {
      tenantId: tenant.id,
      timezone: tenant.timezone,
      config: tenant.config,
      slotDays: 3,
    });

    const depois = await prisma.slot.findMany({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE },
      select: { id: true, doctorId: true, unitId: true, specialtyId: true, startsAt: true, endsAt: true },
    });
    const idPorChave = new Map(depois.map((s) => [chaveSlot(s), s.id]));

    // Todo horário que sobreviveu à renovação manteve o MESMO id.
    let sobreviventes = 0;
    for (const s of antes) {
      const novoId = idPorChave.get(chaveSlot(s));
      if (novoId === undefined) continue; // saiu da janela: legítimo
      expect(novoId).toBe(s.id);
      sobreviventes++;
    }
    expect(sobreviventes).toBeGreaterThan(0);
  });

  it("a reserva da fila sobrevive à renovação diária", async () => {
    const slot = await prisma.slot.findFirstOrThrow({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE },
      orderBy: { startsAt: "desc" }, // bem dentro da janela, não na borda
    });
    const ate = new Date(Date.now() + 30 * 60_000);
    await prisma.slot.update({
      where: { id: slot.id },
      data: { reservedUntil: ate, reservedForPatientId: "paciente-convidado" },
    });

    await regenerateSlots(prisma, {
      tenantId: tenant.id,
      timezone: tenant.timezone,
      config: tenant.config,
      slotDays: 3,
    });

    const depois = await prisma.slot.findUnique({ where: { id: slot.id } });
    expect(depois).not.toBeNull();
    expect(depois!.reservedForPatientId).toBe("paciente-convidado");
  });
});
