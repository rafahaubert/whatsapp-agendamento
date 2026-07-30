import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { prisma } from "../../src/db/client.js";
import { seedClinic, regenerateSlots } from "../../src/db/seed.js";
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

  it("REGRESSÃO: dois agendamentos SIMULTÂNEOS no mesmo slot — só um passa", async () => {
    const [a, b] = await Promise.all([
      scheduling.findOrCreatePatient(tenant.id, {
        nome: "Corrida Um",
        cpf: "111.444.777-35",
        phone: "+5511900000001",
      }) as Promise<{ patientId: string }>,
      scheduling.findOrCreatePatient(tenant.id, {
        nome: "Corrida Dois",
        cpf: "222.555.888-46",
        phone: "+5511900000002",
      }) as Promise<{ patientId: string }>,
    ]);

    const slot = await prisma.slot.findFirstOrThrow({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE },
      orderBy: { startsAt: "asc" },
    });

    // Disparadas juntas de propósito: antes as duas liam "livre" e as duas gravavam.
    const [r1, r2] = await Promise.all([
      scheduling.bookAppointment(tenant, a.patientId, slot.id, "PARTICULAR"),
      scheduling.bookAppointment(tenant, b.patientId, slot.id, "PARTICULAR"),
    ]);

    const sucessos = [r1, r2].filter((r) => "status" in r && r.status === "AGENDADO");
    const erros = [r1, r2].filter((r) => "erro" in r);
    expect(sucessos).toHaveLength(1);
    expect(erros).toHaveLength(1);

    // E o banco tem exatamente UM agendamento vivo para o slot.
    const vivos = await prisma.appointment.count({
      where: { slotId: slot.id, status: { not: "CANCELLED" } },
    });
    expect(vivos).toBe(1);
  });

  it("REGRESSÃO: slots DISTINTOS do mesmo profissional no mesmo horário não geram overbooking", async () => {
    // Este é o furo que o índice único em Appointment.slotId NÃO cobre: dois
    // registros de slot diferentes, mesmo dentista, mesmo instante. Acontece de
    // verdade porque cancelar cria um slot novo em vez de reabrir o antigo.
    const base = await prisma.slot.findFirstOrThrow({
      where: { tenantId: tenant.id, status: SlotStatus.AVAILABLE },
      orderBy: { startsAt: "desc" },
    });

    const gemeo = await prisma.slot.create({
      data: {
        tenantId: base.tenantId,
        unitId: base.unitId,
        doctorId: base.doctorId, // MESMO profissional
        specialtyId: base.specialtyId,
        startsAt: base.startsAt, // MESMO horário
        endsAt: base.endsAt,
        status: SlotStatus.AVAILABLE,
      },
    });

    const [c, d] = await Promise.all([
      scheduling.findOrCreatePatient(tenant.id, {
        nome: "Gemeo Um",
        cpf: "333.666.999-57",
        phone: "+5511900000003",
      }) as Promise<{ patientId: string }>,
      scheduling.findOrCreatePatient(tenant.id, {
        nome: "Gemeo Dois",
        cpf: "123.456.789-09",
        phone: "+5511900000004",
      }) as Promise<{ patientId: string }>,
    ]);

    const [r1, r2] = await Promise.all([
      scheduling.bookAppointment(tenant, c.patientId, base.id, "PARTICULAR"),
      scheduling.bookAppointment(tenant, d.patientId, gemeo.id, "PARTICULAR"),
    ]);

    const sucessos = [r1, r2].filter((r) => "status" in r && r.status === "AGENDADO");
    expect(sucessos).toHaveLength(1);

    // O dentista não pode terminar com duas consultas no mesmo instante.
    const doDentista = await prisma.appointment.count({
      where: {
        tenantId: tenant.id,
        status: { not: "CANCELLED" },
        slot: { doctorId: base.doctorId, startsAt: base.startsAt },
      },
    });
    expect(doDentista).toBe(1);
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

  it("reconhece pelo telefone quem já é paciente, sem pedir CPF de novo", async () => {
    const telefone = "+5551988887777";
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Josué Santana",
      cpf: "111.444.777-35",
      phone: telefone,
    })) as { patientId: string };

    // O webhook da Meta entrega o número SEM o "+": tem de ser o mesmo paciente.
    const doTelefone = await scheduling.pacientesDoTelefone(tenant.id, "5551988887777");
    expect(doTelefone.map((c) => c.id)).toEqual([p.patientId]);

    // Ele responde só o primeiro nome — e isso basta, o CPF fica de fora.
    const achado = (await scheduling.identificarPaciente(tenant.id, {
      nome: "Josué",
      phone: telefone,
    })) as { patientId?: string; novo?: boolean };
    expect(achado.patientId).toBe(p.patientId);
    expect(achado.novo).toBe(false);
  });

  it("telefone de família: quem não está na lista ainda precisa de CPF", async () => {
    const telefone = "+5551955554444";
    await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Carla Prado",
      cpf: "231.002.999-81",
      phone: telefone,
    });

    // A filha, que ainda não tem cadastro: sem CPF a ferramenta não inventa ficha.
    const semCadastro = (await scheduling.identificarPaciente(tenant.id, {
      nome: "Beatriz Prado",
      phone: telefone,
    })) as { erro?: string };
    expect(semCadastro.erro).toMatch(/CPF/i);

    const criada = (await scheduling.identificarPaciente(tenant.id, {
      nome: "Beatriz Prado",
      cpf: "153.509.460-56",
      phone: telefone,
    })) as { patientId?: string; novo?: boolean };
    expect(criada.novo).toBe(true);

    // Agora o número tem duas fichas — e o nome desempata.
    const cadastros = await scheduling.pacientesDoTelefone(tenant.id, telefone);
    expect(cadastros).toHaveLength(2);
    const beatriz = (await scheduling.identificarPaciente(tenant.id, {
      nome: "Beatriz",
      phone: telefone,
    })) as { patientId?: string };
    expect(beatriz.patientId).toBe(criada.patientId);
  });

  it("identificar_paciente sem CPF, pela ferramenta, para quem já tem cadastro", async () => {
    const telefone = "+5551933332222";
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Roberto Lima",
      cpf: "790.573.610-51",
      phone: telefone,
    })) as { patientId: string };

    const ctx = { tenant, phone: telefone };
    const r = (await executeTool("identificar_paciente", { nome: "Roberto" }, ctx)) as {
      patientId?: string;
    };

    expect(r.patientId).toBe(p.patientId);
    // A ferramenta também preenche o contexto, que é o que agendar consulta.
    expect((ctx as { patientId?: string }).patientId).toBe(p.patientId);
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

    // O slot do agendamento cancelado continua preso a ele (histórico + FK)…
    const antigo = await prisma.slot.findUniqueOrThrow({ where: { id: slotId } });
    expect(antigo.status).toBe(SlotStatus.BOOKED);

    // …e o horário volta para a agenda como um slot NOVO, livre.
    const livre = await prisma.slot.findFirst({
      where: {
        tenantId: tenant.id,
        doctorId: antigo.doctorId,
        startsAt: antigo.startsAt,
        status: SlotStatus.AVAILABLE,
      },
    });
    expect(livre).not.toBeNull();
    expect(livre?.id).not.toBe(slotId);

    // REGRESSÃO: reagendar o horário liberado estourava P2002 (slotId único).
    const rebook = (await scheduling.bookAppointment(
      tenant,
      p.patientId,
      livre!.id,
      "PARTICULAR",
    )) as { status?: string; erro?: string };
    expect(rebook.erro).toBeUndefined();
    expect(rebook.status).toBe("AGENDADO");

    await scheduling.cancelAppointment(tenant, appt.appointmentId);
  });

  it("REGRESSÃO: renovar a agenda depois de um cancelamento não quebra (FK slotId)", async () => {
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Beltrano de Teste",
      cpf: "168.995.350-09",
      phone: "+5551976707700",
    })) as { patientId: string };

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    const appt = (await scheduling.bookAppointment(
      tenant,
      p.patientId,
      slots.horarios[0].slotId,
      "PARTICULAR",
    )) as { appointmentId: string };
    await scheduling.cancelAppointment(tenant, appt.appointmentId);

    // Era aqui que a renovação diária morria: slot.deleteMany() no slot preso
    // ao agendamento cancelado violava appointments_slotId_fkey (RESTRICT).
    await expect(
      regenerateSlots(prisma, {
        tenantId: tenant.id,
        timezone: tenant.timezone,
        config: tenant.config,
        slotDays: 3,
      }),
    ).resolves.toBeGreaterThan(0);
  });

  it("renovar a agenda conserta slot antigo que ficou livre com agendamento preso", async () => {
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Legado de Teste",
      cpf: "111.444.777-35",
      phone: "+5551976707702",
    })) as { patientId: string };

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    const slotId = slots.horarios[0].slotId;
    const appt = (await scheduling.bookAppointment(tenant, p.patientId, slotId, "PARTICULAR")) as {
      appointmentId: string;
    };

    // Estado que o banco de produção herdou do comportamento antigo: o
    // cancelamento devolvia o slot para AVAILABLE sem soltar o agendamento.
    await prisma.appointment.update({
      where: { id: appt.appointmentId },
      data: { status: "CANCELLED" },
    });
    await prisma.slot.update({ where: { id: slotId }, data: { status: SlotStatus.AVAILABLE } });

    await regenerateSlots(prisma, {
      tenantId: tenant.id,
      timezone: tenant.timezone,
      config: tenant.config,
      slotDays: 3,
    });

    // O slot preso sobrevive (marcado como ocupado)…
    const antigo = await prisma.slot.findUniqueOrThrow({ where: { id: slotId } });
    expect(antigo.status).toBe(SlotStatus.BOOKED);

    // …e o horário volta a ser oferecido num slot livre de verdade.
    const livre = await prisma.slot.findFirst({
      where: {
        tenantId: tenant.id,
        status: SlotStatus.AVAILABLE,
        doctorId: antigo.doctorId,
        startsAt: antigo.startsAt,
      },
    });
    expect(livre).not.toBeNull();
    expect(livre?.id).not.toBe(slotId);
  });

  it("REGRESSÃO: renovar a agenda não reabre horário de consulta ativa", async () => {
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome: "Sicrano de Teste",
      cpf: "111.444.777-35",
      phone: "+5551976707701",
    })) as { patientId: string };

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    await scheduling.bookAppointment(tenant, p.patientId, slots.horarios[0].slotId, "PARTICULAR");
    const ocupado = await prisma.slot.findUniqueOrThrow({ where: { id: slots.horarios[0].slotId } });

    await regenerateSlots(prisma, {
      tenantId: tenant.id,
      timezone: tenant.timezone,
      config: tenant.config,
      slotDays: 3,
    });

    const livres = await prisma.slot.count({
      where: {
        tenantId: tenant.id,
        status: SlotStatus.AVAILABLE,
        doctorId: ocupado.doctorId,
        startsAt: ocupado.startsAt,
      },
    });
    expect(livres).toBe(0);
  });
});

/**
 * O paciente é UMA pessoa: não pode estar em duas cadeiras ao mesmo tempo.
 * A trava de conflito só olhava o profissional, então dois médicos diferentes
 * no mesmo horário passavam direto (visto em produção no painel).
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("paciente em dois lugares ao mesmo tempo", () => {
  /** Cria um segundo profissional com um slot no MESMO horário de `modelo`. */
  async function slotDeOutroMedico(modelo: { startsAt: Date; endsAt: Date }, nome: string) {
    const outro = await prisma.doctor.create({
      data: {
        tenantId: tenant.id,
        name: nome,
        specialties: { connect: { id: (await especialidade()).id } },
        units: { connect: { id: (await unidade()).id } },
      },
    });
    return prisma.slot.create({
      data: {
        tenantId: tenant.id,
        unitId: (await unidade()).id,
        doctorId: outro.id,
        specialtyId: (await especialidade()).id,
        startsAt: modelo.startsAt,
        endsAt: modelo.endsAt,
        status: SlotStatus.AVAILABLE,
      },
    });
  }

  const especialidade = () =>
    prisma.specialty.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Clínico Geral" } });
  const unidade = () => prisma.unit.findFirstOrThrow({ where: { tenantId: tenant.id } });

  async function pacienteNovo(nome: string, cpf: string) {
    const p = (await scheduling.findOrCreatePatient(tenant.id, {
      nome,
      cpf,
      phone: "+5551976707799",
    })) as { patientId?: string; erro?: string };
    // Sem isto, um CPF inválido vira patientId undefined e o teste falha lá na
    // frente, com erro do Prisma em vez do motivo real.
    if (!p.patientId) throw new Error(`paciente de teste não criado: ${p.erro}`);
    return p.patientId;
  }

  it("REGRESSÃO: recusa o mesmo paciente com dois profissionais no mesmo horário", async () => {
    const patientId = await pacienteNovo("Otavio da Silva", "263.946.533-30");

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    const primeiro = await prisma.slot.findUniqueOrThrow({
      where: { id: slots.horarios[0].slotId },
    });
    const ok = await scheduling.bookAppointment(tenant, patientId, primeiro.id, "PARTICULAR");
    expect(ok).not.toHaveProperty("erro");

    const concorrente = await slotDeOutroMedico(primeiro, "Dr. Arnaldo Pereira");
    const r = await scheduling.bookAppointment(tenant, patientId, concorrente.id, "PARTICULAR");

    expect(r).toHaveProperty("erro");
    expect((r as { erro: string }).erro).toContain("já tem uma consulta");

    // E não pode ter deixado rastro: o slot do segundo médico segue livre.
    const depois = await prisma.slot.findUniqueOrThrow({ where: { id: concorrente.id } });
    expect(depois.status).toBe(SlotStatus.AVAILABLE);
    expect(
      await prisma.appointment.count({ where: { patientId, status: { not: "CANCELLED" } } }),
    ).toBe(1);
  });

  it("outro paciente PODE usar o mesmo horário com outro profissional", async () => {
    const umPaciente = await pacienteNovo("Teresa Nunes", "356.916.710-06");

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    const primeiro = await prisma.slot.findUniqueOrThrow({
      where: { id: slots.horarios[0].slotId },
    });
    await scheduling.bookAppointment(tenant, umPaciente, primeiro.id, "PARTICULAR");

    const concorrente = await slotDeOutroMedico(primeiro, "Dra. Marina Alves");
    const outroPaciente = await pacienteNovo("Mauricio Lima", "168.995.350-09");
    const r = await scheduling.bookAppointment(tenant, outroPaciente, concorrente.id, "PARTICULAR");

    expect(r).not.toHaveProperty("erro");
  });

  it("REGRESSÃO: remarcar também não pode empilhar o paciente no mesmo horário", async () => {
    const patientId = await pacienteNovo("Joana Prado", "100.002.613-27");

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    // Duas consultas do mesmo paciente, em horários diferentes.
    const slotA = await prisma.slot.findUniqueOrThrow({ where: { id: slots.horarios[0].slotId } });
    await scheduling.bookAppointment(tenant, patientId, slotA.id, "PARTICULAR");

    const depois = (await scheduling.listAvailableSlots(tenant, {
      especialidade: "Clínico Geral",
    })) as { horarios: { slotId: string }[] };
    const slotB = await prisma.slot.findUniqueOrThrow({ where: { id: depois.horarios[0].slotId } });
    const segunda = (await scheduling.bookAppointment(
      tenant,
      patientId,
      slotB.id,
      "PARTICULAR",
    )) as { appointmentId: string };

    // Remarcar a segunda para cima da primeira (outro médico, mesma hora).
    const emCimaDaPrimeira = await slotDeOutroMedico(slotA, "Dr. Ricardo Nunes");
    const r = await scheduling.rescheduleAppointment(
      tenant,
      segunda.appointmentId,
      emCimaDaPrimeira.id,
    );

    expect(r).toHaveProperty("erro");
    expect((r as { erro: string }).erro).toContain("já tem uma consulta");
  });

  it("remarcar para outro horário livre continua funcionando", async () => {
    const patientId = await pacienteNovo("Carlos Dias", "100.012.591-21");

    const slots = (await scheduling.listAvailableSlots(tenant, { especialidade: "Clínico Geral" })) as {
      horarios: { slotId: string }[];
    };
    const inicial = (await scheduling.bookAppointment(
      tenant,
      patientId,
      slots.horarios[0].slotId,
      "PARTICULAR",
    )) as { appointmentId: string };

    const livres = (await scheduling.listAvailableSlots(tenant, {
      especialidade: "Clínico Geral",
    })) as { horarios: { slotId: string }[] };
    const r = await scheduling.rescheduleAppointment(
      tenant,
      inicial.appointmentId,
      livres.horarios[0].slotId,
    );

    expect(r).not.toHaveProperty("erro");
  });
});
