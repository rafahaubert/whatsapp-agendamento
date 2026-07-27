import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/ai/systemPrompt.js";
import type { ResolvedTenant } from "../../src/db/tenantRepository.js";

/** Clínica que abre 08:00–18:00 de seg a sex e 08:00–12:00 no sábado. */
const DIAS_PADRAO = {
  0: null,
  1: { open: "08:00", close: "18:00" },
  2: { open: "08:00", close: "18:00" },
  3: { open: "08:00", close: "18:00" },
  4: { open: "08:00", close: "18:00" },
  5: { open: "08:00", close: "18:00" },
  6: { open: "08:00", close: "12:00" },
};

function fakeTenant(
  overrides: Partial<ResolvedTenant["config"]["booking"]> = {},
  days: ResolvedTenant["config"]["businessHours"]["days"] = {},
): ResolvedTenant {
  return {
    id: "t1",
    slug: "clinica-teste",
    name: "Clínica Teste",
    timezone: "America/Sao_Paulo",
    whatsappPhoneNumberId: "123",
    config: {
      branding: {
        clinicName: "Clínica Teste",
        greetingMessage: "Olá!",
        fallbackMessage: "Não entendi.",
        closingMessage: "Até breve!",
      },
      businessHours: { timezone: "America/Sao_Paulo", days },
      booking: {
        slotDurationMinutes: 30,
        maxOptionsOffered: 3,
        advanceBookingDays: 30,
        allowCancellation: true,
        allowReschedule: true,
        askInsurance: true,
        acceptParticular: true,
        ...overrides,
      },
      ai: { model: "claude-haiku-4-5", persona: "Persona de teste." },
    },
  };
}

describe("buildSystemPrompt", () => {
  it("inclui o nome da clínica e a persona", () => {
    const prompt = buildSystemPrompt(fakeTenant());
    expect(prompt).toContain("Clínica Teste");
    expect(prompt).toContain("Persona de teste.");
  });

  it("reflete a regra quando cancelamento é proibido", () => {
    const prompt = buildSystemPrompt(fakeTenant({ allowCancellation: false }));
    expect(prompt).toContain("Cancelamentos NÃO são permitidos");
  });

  it("respeita maxOptionsOffered", () => {
    const prompt = buildSystemPrompt(fakeTenant({ maxOptionsOffered: 5 }));
    expect(prompt).toContain("até 5 opções");
  });

  it("faz triagem e pergunta preferência de dia antes de buscar horários", () => {
    const prompt = buildSystemPrompt(fakeTenant());
    const posNecessidade = prompt.indexOf("ENTENDA A NECESSIDADE");
    const posPreferencia = prompt.indexOf("PREFERÊNCIA DE DIA");
    const posHorarios = prompt.indexOf("listar_horarios");

    expect(posNecessidade).toBeGreaterThan(-1);
    expect(posPreferencia).toBeGreaterThan(posNecessidade);
    expect(posHorarios).toBeGreaterThan(posPreferencia);
  });

  it("proíbe perguntar qual profissional o paciente quer", () => {
    expect(buildSystemPrompt(fakeTenant())).toContain("Não pergunte qual PROFISSIONAL");
  });

  it("REGRESSÃO: não oferece 'noite' quando a clínica fecha às 18h", () => {
    const prompt = buildSystemPrompt(fakeTenant({}, DIAS_PADRAO));
    expect(prompt).toContain("prefere manhã ou tarde?");
    expect(prompt).toContain("Períodos que existem na agenda: manhã ou tarde.");
    expect(prompt).not.toContain("manhã, tarde ou noite");
  });

  it("diz qual é o último horário de cada dia", () => {
    const prompt = buildSystemPrompt(fakeTenant({}, DIAS_PADRAO));
    expect(prompt).toContain("seg, ter, qua, qui, sex: 17:30 · sáb: 11:30");
  });

  it("oferece a noite quando a agenda realmente vai até lá", () => {
    const prompt = buildSystemPrompt(
      fakeTenant({}, { 0: null, 1: { open: "08:00", close: "22:00" } }),
    );
    expect(prompt).toContain("prefere manhã, tarde ou noite?");
  });

  it("REGRESSÃO: com 'Perguntar convênio' desmarcado, proíbe falar de convênio", () => {
    const prompt = buildSystemPrompt(fakeTenant({ askInsurance: false }, DIAS_PADRAO));
    expect(prompt).toContain("NUNCA pergunte se é particular ou convênio");
    expect(prompt).not.toContain("Pergunte se será PARTICULAR ou por CONVÊNIO");
    expect(prompt).not.toContain("Para convênio, depende do plano");
  });

  it("com 'Perguntar convênio' marcado, mantém o passo de convênio", () => {
    const prompt = buildSystemPrompt(fakeTenant({ askInsurance: true }, DIAS_PADRAO));
    expect(prompt).toContain("Pergunte se será PARTICULAR ou por CONVÊNIO");
    expect(prompt).not.toContain("NUNCA pergunte se é particular ou convênio");
  });

  it("REGRESSÃO: exige confirmação explícita e isolada antes de agendar", () => {
    const prompt = buildSystemPrompt(fakeTenant({}, DIAS_PADRAO));
    expect(prompt).toContain("NUNCA chame agendar sem uma confirmação explícita");
    expect(prompt).toContain("NUNCA junte o pedido de confirmação com outra pergunta");
    expect(prompt).toContain("Escolher um horário NÃO é confirmar");
  });

  // O bot escrevia os horários no texto E o sistema mandava os mesmos botões.
  it("com botões (até 3 opções), manda NÃO repetir os horários no texto", () => {
    const prompt = buildSystemPrompt(fakeTenant({ maxOptionsOffered: 3 }, DIAS_PADRAO));
    expect(prompt).toContain("NÃO escreva os horários no texto");
    expect(prompt).not.toContain("escreva-os no texto numerados");
    expect(prompt).not.toContain("opções, NUMERADAS");
  });

  // Acima de 3 vira lista interativa: o paciente só a vê depois de abrir.
  it("com lista (mais de 3 opções), manda escrever os horários no texto", () => {
    const prompt = buildSystemPrompt(fakeTenant({ maxOptionsOffered: 5 }, DIAS_PADRAO));
    expect(prompt).toContain("escreva-os no texto numerados");
    expect(prompt).toContain("opções, NUMERADAS");
    expect(prompt).not.toContain("NÃO escreva os horários no texto");
  });

  it("explica como pedir dia e horário exato em listar_horarios", () => {
    const prompt = buildSystemPrompt(fakeTenant({}, DIAS_PADRAO));
    expect(prompt).toContain("horaPreferida no formato HH:MM");
    expect(prompt).toContain("\"16h30\" é \"16:30\"");
    expect(prompt).toContain("exato=false");
  });
});
