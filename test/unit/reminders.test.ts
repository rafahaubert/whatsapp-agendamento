import { describe, it, expect } from "vitest";
import { selecionarParaLembrete, type AgendamentoLembrete } from "../../src/jobs/reminders.js";

const agora = new Date("2026-07-27T10:00:00.000Z");
const daqui = (horas: number) => new Date(agora.getTime() + horas * 3_600_000);

function ag(over: Partial<AgendamentoLembrete> & { id: string }): AgendamentoLembrete {
  return { status: "SCHEDULED", reminderSentAt: null, startsAt: daqui(5), ...over };
}

describe("selecionarParaLembrete", () => {
  it("seleciona consultas dentro da janela de antecedência", () => {
    const lista = [ag({ id: "a", startsAt: daqui(5) }), ag({ id: "b", startsAt: daqui(23) })];
    expect(selecionarParaLembrete(lista, agora, 24).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("ignora consultas além da janela", () => {
    const lista = [ag({ id: "longe", startsAt: daqui(48) })];
    expect(selecionarParaLembrete(lista, agora, 24)).toHaveLength(0);
  });

  it("ignora consultas no passado", () => {
    const lista = [ag({ id: "passado", startsAt: daqui(-2) })];
    expect(selecionarParaLembrete(lista, agora, 24)).toHaveLength(0);
  });

  it("não reenvia lembrete já enviado (idempotência)", () => {
    const lista = [ag({ id: "ja", reminderSentAt: daqui(-1) })];
    expect(selecionarParaLembrete(lista, agora, 24)).toHaveLength(0);
  });

  it("ignora cancelados e faltas", () => {
    const lista = [
      ag({ id: "cancelado", status: "CANCELLED" }),
      ag({ id: "faltou", status: "NO_SHOW" }),
      ag({ id: "confirmado", status: "CONFIRMED" }),
    ];
    expect(selecionarParaLembrete(lista, agora, 24).map((a) => a.id)).toEqual(["confirmado"]);
  });
});
