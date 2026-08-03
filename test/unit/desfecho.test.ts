import { describe, it, expect } from "vitest";
import {
  podePerguntar,
  devePresumir,
  HORAS_APOS_CONSULTA_PADRAO,
  DIAS_PARA_PRESUMIR_PADRAO,
  type ConsultaSemDesfecho,
} from "../../src/jobs/desfecho.js";

const agora = new Date("2026-07-27T15:00:00.000Z");
const daqui = (horas: number) => new Date(agora.getTime() + horas * 3_600_000);

function consulta(over: Partial<ConsultaSemDesfecho> = {}): ConsultaSemDesfecho {
  return {
    id: "a",
    status: "SCHEDULED",
    endsAt: daqui(-4), // terminou há 4h: já passou da carência padrão de 3h
    outcomeAskedAt: null,
    ultimaMensagemPaciente: daqui(-2), // escreveu há 2h: janela da Meta aberta
    ...over,
  };
}

describe("podePerguntar", () => {
  it("pergunta a quem terminou a consulta e ainda está na janela da Meta", () => {
    expect(podePerguntar(consulta(), agora)).toBe(true);
  });

  it("não pergunta antes de a consulta terminar", () => {
    expect(podePerguntar(consulta({ endsAt: daqui(2) }), agora)).toBe(false);
  });

  it("espera a carência depois do fim da consulta", () => {
    expect(podePerguntar(consulta({ endsAt: daqui(-1) }), agora)).toBe(false);
    expect(podePerguntar(consulta({ endsAt: daqui(-3.1) }), agora)).toBe(true);
    // A clínica pode encurtar ou alongar a espera.
    expect(podePerguntar(consulta({ endsAt: daqui(-1) }), agora, 0.5)).toBe(true);
  });

  it("nunca pergunta duas vezes", () => {
    expect(podePerguntar(consulta({ outcomeAskedAt: daqui(-1) }), agora)).toBe(false);
  });

  it("não pergunta a quem já tem desfecho", () => {
    expect(podePerguntar(consulta({ status: "COMPLETED" }), agora)).toBe(false);
    expect(podePerguntar(consulta({ status: "NO_SHOW" }), agora)).toBe(false);
    expect(podePerguntar(consulta({ status: "CANCELLED" }), agora)).toBe(false);
  });

  // A pergunta é de graça só DENTRO da janela de 24h da Meta. Fora dela a
  // mensagem livre é recusada e a pergunta custaria um template aprovado — que
  // é exatamente o que este job existe para evitar.
  it("não pergunta a quem está fora da janela de 24h da Meta", () => {
    expect(podePerguntar(consulta({ ultimaMensagemPaciente: daqui(-21) }), agora)).toBe(false);
    expect(podePerguntar(consulta({ ultimaMensagemPaciente: null }), agora)).toBe(false);
  });

  it("o padrão da carência é o documentado", () => {
    expect(HORAS_APOS_CONSULTA_PADRAO).toBe(3);
  });
});

describe("devePresumir", () => {
  it("presume comparecimento depois do silêncio longo", () => {
    expect(devePresumir(consulta({ endsAt: daqui(-24 * 4) }), agora)).toBe(true);
  });

  it("não presume enquanto o prazo não fecha", () => {
    expect(devePresumir(consulta({ endsAt: daqui(-24 * 2) }), agora)).toBe(false);
  });

  it("não mexe em quem já tem desfecho", () => {
    expect(devePresumir(consulta({ status: "COMPLETED", endsAt: daqui(-24 * 9) }), agora)).toBe(false);
    expect(devePresumir(consulta({ status: "CANCELLED", endsAt: daqui(-24 * 9) }), agora)).toBe(false);
  });

  // A presunção puxa a taxa de falta para baixo. A clínica que prefere um número
  // menor porém apurado tem de conseguir desligá-la.
  it("dias = 0 desliga a presunção", () => {
    expect(devePresumir(consulta({ endsAt: daqui(-24 * 30) }), agora, 0)).toBe(false);
  });

  it("o padrão do prazo é o documentado", () => {
    expect(DIAS_PARA_PRESUMIR_PADRAO).toBe(3);
  });
});
