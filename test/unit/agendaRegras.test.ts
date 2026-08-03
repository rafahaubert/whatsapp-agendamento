import { describe, it, expect } from "vitest";
import type { DiaAtendimento } from "../../src/config/types.js";
import { minutosDoDia, noIntervalo, estaBloqueado, estaOcupado } from "../../src/db/seed.js";

describe("minutosDoDia", () => {
  it("converte HH:MM em minutos", () => {
    expect(minutosDoDia("00:00")).toBe(0);
    expect(minutosDoDia("08:30")).toBe(510);
    expect(minutosDoDia("22:00")).toBe(1320);
  });
});

describe("noIntervalo (almoço)", () => {
  const dia = { open: "08:00", close: "18:00", breakStart: "12:00", breakEnd: "13:00" };

  it("descarta o slot que começa no intervalo", () => {
    expect(noIntervalo(minutosDoDia("12:00"), minutosDoDia("12:30"), dia)).toBe(true);
    expect(noIntervalo(minutosDoDia("12:30"), minutosDoDia("13:00"), dia)).toBe(true);
  });

  it("descarta o slot que apenas ENCOSTA no intervalo", () => {
    // 11:45–12:15 invade o almoço
    expect(noIntervalo(minutosDoDia("11:45"), minutosDoDia("12:15"), dia)).toBe(true);
  });

  it("mantém os slots fora do intervalo", () => {
    expect(noIntervalo(minutosDoDia("11:30"), minutosDoDia("12:00"), dia)).toBe(false);
    expect(noIntervalo(minutosDoDia("13:00"), minutosDoDia("13:30"), dia)).toBe(false);
    expect(noIntervalo(minutosDoDia("08:00"), minutosDoDia("08:30"), dia)).toBe(false);
  });

  it("sem intervalo configurado, nada é descartado (compatível com o formato antigo)", () => {
    const semAlmoco: DiaAtendimento = { open: "08:00", close: "18:00" };
    expect(noIntervalo(minutosDoDia("12:00"), minutosDoDia("12:30"), semAlmoco)).toBe(false);
  });

  it("ignora intervalo inválido (fim antes do início)", () => {
    const invalido = { open: "08:00", close: "18:00", breakStart: "13:00", breakEnd: "12:00" };
    expect(noIntervalo(minutosDoDia("12:30"), minutosDoDia("13:00"), invalido)).toBe(false);
  });
});

describe("estaBloqueado (férias e feriados)", () => {
  const d = (iso: string) => new Date(iso);
  const feriado = { doctorId: null, startsAt: d("2026-09-07T00:00:00Z"), endsAt: d("2026-09-08T00:00:00Z") };
  const feriasDr1 = { doctorId: "dr1", startsAt: d("2026-08-01T00:00:00Z"), endsAt: d("2026-08-15T00:00:00Z") };

  it("feriado da clínica bloqueia qualquer profissional", () => {
    expect(estaBloqueado(d("2026-09-07T10:00:00Z"), d("2026-09-07T10:30:00Z"), "dr9", [feriado])).toBe(true);
  });

  it("férias bloqueiam apenas o profissional dono do bloqueio", () => {
    const inicio = d("2026-08-05T10:00:00Z");
    const fim = d("2026-08-05T10:30:00Z");
    expect(estaBloqueado(inicio, fim, "dr1", [feriasDr1])).toBe(true);
    expect(estaBloqueado(inicio, fim, "dr2", [feriasDr1])).toBe(false);
  });

  it("libera horários fora do período", () => {
    expect(estaBloqueado(d("2026-08-20T10:00:00Z"), d("2026-08-20T10:30:00Z"), "dr1", [feriasDr1])).toBe(false);
  });

  it("sem bloqueios, nada é barrado", () => {
    expect(estaBloqueado(d("2026-08-05T10:00:00Z"), d("2026-08-05T10:30:00Z"), "dr1", [])).toBe(false);
  });
});

describe("estaOcupado (consultas já marcadas)", () => {
  const d = (iso: string) => new Date(iso);
  const consulta = {
    doctorId: "dr1",
    startsAt: d("2026-08-05T13:00:00Z"),
    endsAt: d("2026-08-05T13:30:00Z"),
  };

  it("barra o horário exato da consulta", () => {
    expect(estaOcupado(d("2026-08-05T13:00:00Z"), d("2026-08-05T13:30:00Z"), "dr1", [consulta])).toBe(true);
  });

  it("barra qualquer sobreposição (consulta fora da grade)", () => {
    expect(estaOcupado(d("2026-08-05T12:45:00Z"), d("2026-08-05T13:15:00Z"), "dr1", [consulta])).toBe(true);
  });

  it("não barra outro profissional no mesmo horário", () => {
    expect(estaOcupado(d("2026-08-05T13:00:00Z"), d("2026-08-05T13:30:00Z"), "dr2", [consulta])).toBe(false);
  });

  it("horários encostados (fim = início) continuam livres", () => {
    expect(estaOcupado(d("2026-08-05T12:30:00Z"), d("2026-08-05T13:00:00Z"), "dr1", [consulta])).toBe(false);
    expect(estaOcupado(d("2026-08-05T13:30:00Z"), d("2026-08-05T14:00:00Z"), "dr1", [consulta])).toBe(false);
  });
});
