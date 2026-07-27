import { describe, it, expect } from "vitest";
import { formatDateTime, formatDate, janelaDoDia } from "../../src/shared/datetime.js";

const TZ = "America/Sao_Paulo";
// Segunda-feira, 27/07/2026, 22:00 em São Paulo (o caso do print: "na quarta, teria?").
const SEGUNDA_22H = new Date("2026-07-28T01:00:00Z");

describe("formatDateTime", () => {
  it("formata no fuso de São Paulo (UTC-3) em pt-BR", () => {
    // 17:30 UTC = 14:30 em America/Sao_Paulo
    const d = new Date("2026-07-24T17:30:00Z");
    const s = formatDateTime(d, TZ);
    expect(s).toContain("14:30");
    expect(s).toContain("24/07");
  });
});

describe("formatDate", () => {
  it("mostra o dia sem a hora", () => {
    const s = formatDate(new Date("2026-07-29T17:30:00Z"), TZ);
    expect(s).toContain("29/07");
    expect(s).not.toContain("14:30");
  });
});

describe("janelaDoDia", () => {
  it("resolve o dia da semana para a próxima ocorrência", () => {
    // De segunda (27/07) para quarta são 2 dias → 29/07.
    const j = janelaDoDia("quarta", TZ, SEGUNDA_22H)!;
    expect(j.rotulo).toContain("29/07");
    expect(formatDateTime(j.inicio, TZ)).toContain("00:00");
  });

  it("aceita as formas que o paciente escreve", () => {
    for (const texto of ["quarta", "Quarta", "qua", "quarta-feira", "na quarta", "QUARTA FEIRA"]) {
      expect(janelaDoDia(texto, TZ, SEGUNDA_22H)?.rotulo).toContain("29/07");
    }
  });

  it("hoje é hoje mesmo quando o dia da semana é o de hoje", () => {
    expect(janelaDoDia("segunda", TZ, SEGUNDA_22H)?.rotulo).toContain("27/07");
    expect(janelaDoDia("hoje", TZ, SEGUNDA_22H)?.rotulo).toContain("27/07");
  });

  // O domínio usa isso para rolar "na quarta" para a semana seguinte quando o
  // paciente pergunta numa quarta à noite, com o dia já esgotado.
  it("marca quando o dia veio de um nome de dia da semana", () => {
    expect(janelaDoDia("quarta", TZ, SEGUNDA_22H)?.diaDaSemana).toBe(true);
    expect(janelaDoDia("29/07", TZ, SEGUNDA_22H)?.diaDaSemana).toBe(false);
    expect(janelaDoDia("amanhã", TZ, SEGUNDA_22H)?.diaDaSemana).toBe(false);
    expect(janelaDoDia("hoje", TZ, SEGUNDA_22H)?.diaDaSemana).toBe(false);
  });

  it("a partir do dia seguinte, o mesmo nome cai na semana que vem", () => {
    const quarta = janelaDoDia("quarta", TZ, SEGUNDA_22H)!;
    const proxima = janelaDoDia("quarta", TZ, quarta.fim)!;
    expect(quarta.rotulo).toContain("29/07");
    expect(proxima.rotulo).toContain("05/08");
  });

  it("entende amanhã e depois de amanhã", () => {
    expect(janelaDoDia("amanhã", TZ, SEGUNDA_22H)?.rotulo).toContain("28/07");
    expect(janelaDoDia("depois de amanhã", TZ, SEGUNDA_22H)?.rotulo).toContain("29/07");
  });

  it("entende datas em pt-BR e ISO", () => {
    expect(janelaDoDia("30/07", TZ, SEGUNDA_22H)?.rotulo).toContain("30/07");
    expect(janelaDoDia("30/07/2026", TZ, SEGUNDA_22H)?.rotulo).toContain("30/07");
    expect(janelaDoDia("2026-07-30", TZ, SEGUNDA_22H)?.rotulo).toContain("30/07");
    expect(janelaDoDia("dia 30", TZ, SEGUNDA_22H)?.rotulo).toContain("30/07");
  });

  it("data sem ano que já passou rola para o ano seguinte", () => {
    const j = janelaDoDia("10/01", TZ, SEGUNDA_22H)!;
    expect(j.inicio.getTime()).toBeGreaterThan(SEGUNDA_22H.getTime());
    expect(j.rotulo).toContain("10/01");
  });

  it("a janela cobre exatamente um dia, à meia-noite local", () => {
    const j = janelaDoDia("quarta", TZ, SEGUNDA_22H)!;
    // 00:00 em São Paulo (UTC-3) = 03:00 UTC.
    expect(j.inicio.toISOString()).toBe("2026-07-29T03:00:00.000Z");
    expect(j.fim.toISOString()).toBe("2026-07-30T03:00:00.000Z");
  });

  it("respeita o fuso da clínica", () => {
    const emManaus = janelaDoDia("quarta", "America/Manaus", SEGUNDA_22H)!;
    expect(emManaus.inicio.toISOString()).toBe("2026-07-29T04:00:00.000Z");
  });

  it("devolve null quando não reconhece", () => {
    expect(janelaDoDia("qualquer dia", TZ, SEGUNDA_22H)).toBeNull();
    expect(janelaDoDia("", TZ, SEGUNDA_22H)).toBeNull();
    expect(janelaDoDia("32/13", TZ, SEGUNDA_22H)).toBeNull();
    // Não deve cair em chave herdada do prototype.
    expect(janelaDoDia("constructor", TZ, SEGUNDA_22H)).toBeNull();
  });
});
