import { describe, it, expect } from "vitest";
import { foraDoHorario, calcularCustoUSD, diagnosticarCache } from "../../src/admin/metrics.js";

const TZ = "America/Sao_Paulo";
const dias = {
  0: null, // domingo fechado
  1: { open: "08:00", close: "18:00" },
  2: { open: "08:00", close: "18:00" },
  3: { open: "08:00", close: "18:00" },
  4: { open: "08:00", close: "18:00" },
  5: { open: "08:00", close: "18:00" },
  6: { open: "08:00", close: "12:00" }, // sábado meio período
};

/** Monta um instante no fuso da clínica (UTC-3). */
const local = (dataISO: string) => new Date(`${dataISO}-03:00`);

describe("foraDoHorario", () => {
  it("dentro do expediente = false", () => {
    // segunda-feira, 10:00
    expect(foraDoHorario(local("2026-07-27T10:00:00"), TZ, dias)).toBe(false);
  });

  it("antes de abrir e depois de fechar = true", () => {
    expect(foraDoHorario(local("2026-07-27T07:30:00"), TZ, dias)).toBe(true);
    expect(foraDoHorario(local("2026-07-27T20:00:00"), TZ, dias)).toBe(true);
  });

  it("no minuto do fechamento já conta como fora", () => {
    expect(foraDoHorario(local("2026-07-27T18:00:00"), TZ, dias)).toBe(true);
    expect(foraDoHorario(local("2026-07-27T17:59:00"), TZ, dias)).toBe(false);
  });

  it("dia fechado (domingo) = sempre fora", () => {
    expect(foraDoHorario(local("2026-07-26T10:00:00"), TZ, dias)).toBe(true);
  });

  it("respeita o horário reduzido do sábado", () => {
    expect(foraDoHorario(local("2026-08-01T10:00:00"), TZ, dias)).toBe(false);
    expect(foraDoHorario(local("2026-08-01T14:00:00"), TZ, dias)).toBe(true);
  });

  it("usa o fuso da clínica, não o do servidor", () => {
    // 23:00 UTC de segunda = 20:00 em São Paulo → fora do expediente
    expect(foraDoHorario(new Date("2026-07-27T23:00:00Z"), TZ, dias)).toBe(true);
    // 12:00 UTC = 09:00 em São Paulo → dentro
    expect(foraDoHorario(new Date("2026-07-27T12:00:00Z"), TZ, dias)).toBe(false);
  });
});

describe("calcularCustoUSD", () => {
  // Haiku: US$ 1/Mtok de entrada, US$ 5/Mtok de saída.
  const zerado = { entrada: 0, saida: 0, cacheEscrita: 0, cacheLeitura: 0 };

  it("cobra entrada e saída pelo preço do modelo", () => {
    const r = calcularCustoUSD(
      { ...zerado, entrada: 1_000_000, saida: 1_000_000 },
      "claude-haiku-4-5",
    );
    expect(r.custoUSD).toBeCloseTo(6, 6);
    expect(r.economiaCacheUSD).toBe(0);
  });

  // O ponto que mais erra: escrever no cache custa MAIS que input normal.
  it("cobra a escrita de cache a 1,25x", () => {
    const r = calcularCustoUSD({ ...zerado, cacheEscrita: 1_000_000 }, "claude-haiku-4-5");
    expect(r.custoUSD).toBeCloseTo(1.25, 6);
    // Escrita não é economia — é o investimento que a torna possível.
    expect(r.economiaCacheUSD).toBe(0);
  });

  it("cobra a leitura de cache a 0,1x e credita a economia", () => {
    const r = calcularCustoUSD({ ...zerado, cacheLeitura: 1_000_000 }, "claude-haiku-4-5");
    expect(r.custoUSD).toBeCloseTo(0.1, 6);
    expect(r.economiaCacheUSD).toBeCloseTo(0.9, 6);
  });

  it("usa o preço do modelo caro quando é ele que está configurado", () => {
    // Opus: US$ 5/Mtok de entrada. Sem promoção, o preço de tabela vale sempre.
    const r = calcularCustoUSD({ ...zerado, entrada: 1_000_000 }, "claude-opus-5");
    expect(r.custoUSD).toBeCloseTo(5, 6);
  });

  it("cai no preço do Haiku quando o modelo é desconhecido", () => {
    const r = calcularCustoUSD({ ...zerado, entrada: 1_000_000 }, "modelo-que-nao-existe");
    expect(r.custoUSD).toBeCloseTo(1, 6);
  });

  // REGRESSÃO: o Sonnet 5 está em preço promocional até 31/08/2026. A tabela
  // cobrava os US$ 3 cheios, superestimando o custo da clínica em 50% — e, pior,
  // um número chumbado continuaria barato depois que a promoção vencesse.
  it("respeita a promoção enquanto ela vale e volta ao preço cheio depois", () => {
    const durante = calcularCustoUSD(
      { ...zerado, entrada: 1_000_000 },
      "claude-sonnet-5",
      new Date("2026-08-03T12:00:00Z"),
    );
    expect(durante.custoUSD).toBeCloseTo(2, 6);

    const depois = calcularCustoUSD(
      { ...zerado, entrada: 1_000_000 },
      "claude-sonnet-5",
      new Date("2026-09-01T12:00:00Z"),
    );
    expect(depois.custoUSD).toBeCloseTo(3, 6);
  });
});

describe("diagnosticarCache", () => {
  const zerado = { entrada: 0, saida: 0, cacheEscrita: 0, cacheLeitura: 0 };

  it("sem volume suficiente não arrisca um veredito", () => {
    expect(diagnosticarCache({ ...zerado, entrada: 5000 }, 10, 3)).toBe(null);
  });

  it("sem consumo nenhum também não arrisca", () => {
    expect(diagnosticarCache(zerado, 10, 50)).toBe(null);
  });

  // REGRESSÃO: é a diferença entre "o cache não compensou" e "o cache nunca foi
  // tentado". Os dois apareciam como economia zero no painel.
  it("com volume e leitura zerada, o cache não está pegando", () => {
    expect(diagnosticarCache({ ...zerado, entrada: 200_000 }, 10, 50)).toBe(false);
  });

  it("qualquer leitura de cache já prova que está pegando", () => {
    expect(diagnosticarCache({ ...zerado, entrada: 200_000, cacheLeitura: 1 }, 10, 50)).toBe(true);
  });
});
