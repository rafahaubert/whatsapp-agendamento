import { describe, it, expect } from "vitest";
import { buildTools } from "../../src/ai/tools.js";
import type { ResolvedTenant } from "../../src/db/tenantRepository.js";

function fakeTenant(askInsurance: boolean): ResolvedTenant {
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
        askInsurance,
        acceptParticular: true,
      },
      ai: { model: "claude-haiku-4-5", persona: "Persona de teste." },
    },
  };
}

const nomes = (t: ResolvedTenant) => buildTools(t).map((f) => f.name);
const agendar = (t: ResolvedTenant) => buildTools(t).find((f) => f.name === "agendar")!;

describe("buildTools", () => {
  it("REGRESSÃO: sem 'Perguntar convênio', o modelo nem enxerga convênio", () => {
    const t = fakeTenant(false);
    expect(nomes(t)).not.toContain("listar_convenios");
    // Sem HEALTH_PLAN no schema, não há o que perguntar.
    expect(Object.keys(agendar(t).input_schema.properties ?? {})).toEqual(["slotId"]);
  });

  it("com 'Perguntar convênio', expõe convênios e forma de pagamento", () => {
    const t = fakeTenant(true);
    expect(nomes(t)).toContain("listar_convenios");
    expect(Object.keys(agendar(t).input_schema.properties ?? {})).toContain("paymentType");
  });

  it("as demais ferramentas continuam disponíveis nos dois casos", () => {
    for (const t of [fakeTenant(true), fakeTenant(false)]) {
      for (const f of ["listar_especialidades", "listar_horarios", "identificar_paciente", "agendar"]) {
        expect(nomes(t)).toContain(f);
      }
    }
  });

  it("listar_horarios aceita dia e horário com minutos", () => {
    const ferramenta = buildTools(fakeTenant(true)).find((f) => f.name === "listar_horarios")!;
    const props = ferramenta.input_schema.properties as Record<string, { type: string }>;
    expect(props.dia).toBeDefined();
    expect(props.horaPreferida.type).toBe("string"); // era integer: 16h30 virava 16h
  });
});
