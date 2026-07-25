import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/ai/systemPrompt.js";
import type { ResolvedTenant } from "../../src/db/tenantRepository.js";

function fakeTenant(overrides: Partial<ResolvedTenant["config"]["booking"]> = {}): ResolvedTenant {
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
      businessHours: { timezone: "America/Sao_Paulo", days: {} },
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
});
