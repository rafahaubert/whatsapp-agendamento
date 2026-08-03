import { describe, it, expect } from "vitest";
import { valeRepetir, esperaAntesDeRepetir } from "../../src/channels/whatsapp/client.js";

describe("valeRepetir", () => {
  // Só o que é transitório. Repetir um 400 de template rejeitado é o mesmo erro
  // três vezes, gastando quota da Meta e atrasando a fila de envio.
  it("repete limite de taxa e falha do servidor", () => {
    expect(valeRepetir(429)).toBe(true);
    expect(valeRepetir(500)).toBe(true);
    expect(valeRepetir(503)).toBe(true);
  });

  it("não repete erro de requisição", () => {
    expect(valeRepetir(400)).toBe(false); // template rejeitado, número inválido
    expect(valeRepetir(401)).toBe(false); // token vencido
    expect(valeRepetir(403)).toBe(false);
    expect(valeRepetir(404)).toBe(false);
  });
});

describe("esperaAntesDeRepetir", () => {
  it("respeita o retry-after da Meta quando ele vem", () => {
    expect(esperaAntesDeRepetir(0, "5")).toBe(5000);
    expect(esperaAntesDeRepetir(2, "1")).toBe(1000);
  });

  // Sem teto, um retry-after absurdo (ou malformado como número enorme) travaria
  // a fila de envio por minutos.
  it("limita a espera pedida pela Meta", () => {
    expect(esperaAntesDeRepetir(0, "600")).toBe(30_000);
  });

  it("cai no backoff exponencial sem retry-after", () => {
    expect(esperaAntesDeRepetir(0, null)).toBe(500);
    expect(esperaAntesDeRepetir(1, null)).toBe(1000);
    expect(esperaAntesDeRepetir(2, null)).toBe(2000);
  });

  it("ignora retry-after que não é número", () => {
    // A Meta pode mandar uma data HTTP em vez de segundos.
    expect(esperaAntesDeRepetir(0, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(500);
    expect(esperaAntesDeRepetir(1, "")).toBe(1000);
  });
});
