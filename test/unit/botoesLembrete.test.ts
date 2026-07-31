import { describe, it, expect } from "vitest";
import { ordemDosBotoes } from "../../src/jobs/reminders.js";
import { ORDEM_BOTOES_LEMBRETE, type AcaoBotaoLembrete } from "../../src/config/types.js";

describe("ordem dos botões do lembrete", () => {
  it("usa a ordem documentada quando a clínica não declara nada", () => {
    expect(ordemDosBotoes(undefined)).toEqual(["CONFIRMAR", "REMARCAR", "CANCELAR"]);
    expect(ordemDosBotoes({})).toEqual(ORDEM_BOTOES_LEMBRETE);
    expect(ordemDosBotoes({ botoes: [] })).toEqual(ORDEM_BOTOES_LEMBRETE);
  });

  it("respeita a ordem declarada pela clínica", () => {
    const invertida: AcaoBotaoLembrete[] = ["CANCELAR", "REMARCAR", "CONFIRMAR"];
    expect(ordemDosBotoes({ botoes: invertida })).toEqual(invertida);
  });

  it("cai no padrão se faltar uma ação — mapeamento pela metade é o caso perigoso", () => {
    expect(ordemDosBotoes({ botoes: ["CONFIRMAR", "CANCELAR"] })).toEqual(ORDEM_BOTOES_LEMBRETE);
  });

  it("cai no padrão se uma ação estiver repetida", () => {
    expect(ordemDosBotoes({ botoes: ["CONFIRMAR", "CONFIRMAR", "CANCELAR"] })).toEqual(
      ORDEM_BOTOES_LEMBRETE,
    );
  });

  it("cai no padrão diante de ação desconhecida", () => {
    const ruim = ["CONFIRMAR", "REMARCAR", "EXPLODIR"] as unknown as AcaoBotaoLembrete[];
    expect(ordemDosBotoes({ botoes: ruim })).toEqual(ORDEM_BOTOES_LEMBRETE);
  });

  it("REGRESSÃO: a ordem declarada gera os payloads na posição certa", () => {
    // Clínica que cadastrou os botões como Cancelar / Remarcar / Confirmar.
    const ordem = ordemDosBotoes({ botoes: ["CANCELAR", "REMARCAR", "CONFIRMAR"] });
    const payloads = ordem.map((acao) => `${acao}:appt-123`);

    // O índice 0 vai para o primeiro botão do template — que nessa clínica é
    // "Cancelar". Antes o código mandava CONFIRMAR: nessa posição, e tocar em
    // "Cancelar" confirmava a consulta.
    expect(payloads[0]).toBe("CANCELAR:appt-123");
    expect(payloads[2]).toBe("CONFIRMAR:appt-123");
  });
});
