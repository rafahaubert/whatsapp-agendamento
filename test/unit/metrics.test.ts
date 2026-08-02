import { describe, it, expect } from "vitest";
import { foraDoHorario, calcularCustoUSD } from "../../src/admin/metrics.js";

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
    const r = calcularCustoUSD({ ...zerado, entrada: 1_000_000 }, "claude-sonnet-5");
    expect(r.custoUSD).toBeCloseTo(3, 6);
  });

  it("cai no preço do Haiku quando o modelo é desconhecido", () => {
    const r = calcularCustoUSD({ ...zerado, entrada: 1_000_000 }, "modelo-que-nao-existe");
    expect(r.custoUSD).toBeCloseTo(1, 6);
  });
});
