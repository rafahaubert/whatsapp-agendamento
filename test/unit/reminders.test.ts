import { describe, it, expect } from "vitest";
import {
  selecionarParaLembrete,
  MAX_TENTATIVAS,
  type AgendamentoLembrete,
} from "../../src/jobs/reminders.js";

const agora = new Date("2026-07-27T10:00:00.000Z");
const daqui = (horas: number) => new Date(agora.getTime() + horas * 3_600_000);

function ag(over: Partial<AgendamentoLembrete> & { id: string }): AgendamentoLembrete {
  return {
    status: "SCHEDULED",
    reminderSentAt: null,
    startsAt: daqui(5),
    // Marcado ontem: passa da carência sem que cada caso precise dizê-lo.
    createdAt: daqui(-24),
    reminderRetryCount: 0,
    ...over,
  };
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

  // Sem este corte o envio que falha nunca grava `reminderSentAt` e volta à fila
  // a cada ciclo do cron, para sempre.
  it("desiste de quem já esgotou as tentativas", () => {
    const lista = [ag({ id: "esgotado", reminderRetryCount: MAX_TENTATIVAS })];
    expect(selecionarParaLembrete(lista, agora, 24)).toHaveLength(0);
  });

  it("ainda tenta quem falhou menos que o limite", () => {
    const lista = [ag({ id: "penultima", reminderRetryCount: MAX_TENTATIVAS - 1 })];
    expect(selecionarParaLembrete(lista, agora, 24).map((a) => a.id)).toEqual(["penultima"]);
  });

  // REGRESSÃO: quem marcava hoje para amanhã caía na janela de 24h na hora e
  // recebia o lembrete no ciclo seguinte de 10 minutos — pagava-se um template
  // à Meta para lembrar o paciente do que ele tinha acabado de fazer.
  it("não lembra quem acabou de agendar", () => {
    const lista = [ag({ id: "recem", createdAt: daqui(-0.2), startsAt: daqui(20) })];
    expect(selecionarParaLembrete(lista, agora, 24)).toHaveLength(0);
  });

  it("lembra assim que a carência passa", () => {
    const lista = [
      ag({ id: "dentro", createdAt: daqui(-5.9), startsAt: daqui(20) }),
      ag({ id: "passou", createdAt: daqui(-6.1), startsAt: daqui(20) }),
    ];
    expect(selecionarParaLembrete(lista, agora, 24).map((a) => a.id)).toEqual(["passou"]);
  });

  it("respeita a carência configurada pela clínica", () => {
    const lista = [ag({ id: "a", createdAt: daqui(-3), startsAt: daqui(20) })];
    // Com a carência padrão (6h) ainda é cedo; com 2h já pode.
    expect(selecionarParaLembrete(lista, agora, 24)).toHaveLength(0);
    expect(selecionarParaLembrete(lista, agora, 24, 2).map((a) => a.id)).toEqual(["a"]);
  });

  // Marcar uma urgência para daqui a pouco é o caso em que o lembrete não faz
  // sentido nenhum: a consulta acontece antes de a carência sequer vencer.
  it("carência zero devolve o comportamento antigo", () => {
    const lista = [ag({ id: "urgencia", createdAt: agora, startsAt: daqui(2) })];
    expect(selecionarParaLembrete(lista, agora, 24)).toHaveLength(0);
    expect(selecionarParaLembrete(lista, agora, 24, 0).map((a) => a.id)).toEqual(["urgencia"]);
  });
});
