import { describe, it, expect } from "vitest";
import { selecionarParaRecall, type PacienteRecall } from "../../src/jobs/recall.js";

const agora = new Date("2026-07-26T12:00:00.000Z");
const mesesAtras = (n: number) => {
  const d = new Date(agora);
  d.setMonth(d.getMonth() - n);
  return d;
};
const diasAtras = (n: number) => new Date(agora.getTime() - n * 86_400_000);

function p(over: Partial<PacienteRecall> & { id: string }): PacienteRecall {
  return { ultimaConsulta: mesesAtras(8), lastRecallAt: null, ...over };
}

describe("selecionarParaRecall", () => {
  it("seleciona quem não vem há mais tempo que o configurado", () => {
    const lista = [p({ id: "sumido", ultimaConsulta: mesesAtras(8) })];
    expect(selecionarParaRecall(lista, agora, 6).map((x) => x.id)).toEqual(["sumido"]);
  });

  it("ignora quem veio recentemente", () => {
    const lista = [p({ id: "recente", ultimaConsulta: mesesAtras(2) })];
    expect(selecionarParaRecall(lista, agora, 6)).toHaveLength(0);
  });

  it("ignora quem nunca teve consulta (não é reativação)", () => {
    const lista = [p({ id: "nunca", ultimaConsulta: null })];
    expect(selecionarParaRecall(lista, agora, 6)).toHaveLength(0);
  });

  // Evita virar spam: no máximo um convite a cada 90 dias.
  it("não repete o convite para quem foi contatado há pouco", () => {
    const lista = [p({ id: "ja-convidado", lastRecallAt: diasAtras(30) })];
    expect(selecionarParaRecall(lista, agora, 6)).toHaveLength(0);
  });

  it("volta a convidar depois do intervalo mínimo", () => {
    const lista = [p({ id: "antigo", lastRecallAt: diasAtras(120) })];
    expect(selecionarParaRecall(lista, agora, 6).map((x) => x.id)).toEqual(["antigo"]);
  });

  it("respeita a janela configurada pela clínica", () => {
    const lista = [p({ id: "x", ultimaConsulta: mesesAtras(4) })];
    expect(selecionarParaRecall(lista, agora, 6)).toHaveLength(0);
    expect(selecionarParaRecall(lista, agora, 3)).toHaveLength(1);
  });
});
