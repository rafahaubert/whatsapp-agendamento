import { describe, it, expect } from "vitest";
import { deveEnviarResumo, HORA_PADRAO } from "../../src/jobs/resumoDiario.js";

const TZ = "America/Sao_Paulo"; // UTC-3
/** Instante UTC que corresponde a uma hora local em São Paulo. */
const local = (dataHora: string) => new Date(`${dataHora}-03:00`);

describe("deveEnviarResumo", () => {
  it("manda na hora configurada quando nunca mandou", () => {
    expect(deveEnviarResumo(local("2026-08-10T08:00:00"), TZ, 8, null)).toBe(true);
    expect(deveEnviarResumo(local("2026-08-10T08:50:00"), TZ, 8, null)).toBe(true);
  });

  it("fica quieto fora da hora configurada", () => {
    expect(deveEnviarResumo(local("2026-08-10T07:59:00"), TZ, 8, null)).toBe(false);
    expect(deveEnviarResumo(local("2026-08-10T09:00:00"), TZ, 8, null)).toBe(false);
    expect(deveEnviarResumo(local("2026-08-10T20:00:00"), TZ, 8, null)).toBe(false);
  });

  // O job roda a cada 10 minutos. Sem esta trava, o dono receberia SEIS resumos
  // entre 8h e 9h, todo dia.
  it("não repete no mesmo dia", () => {
    const jaMandou = local("2026-08-10T08:05:00");
    expect(deveEnviarResumo(local("2026-08-10T08:15:00"), TZ, 8, jaMandou)).toBe(false);
    expect(deveEnviarResumo(local("2026-08-10T08:55:00"), TZ, 8, jaMandou)).toBe(false);
  });

  it("volta a mandar no dia seguinte", () => {
    const ontem = local("2026-08-10T08:05:00");
    expect(deveEnviarResumo(local("2026-08-11T08:00:00"), TZ, 8, ontem)).toBe(true);
  });

  it("respeita a hora escolhida pela clínica", () => {
    expect(deveEnviarResumo(local("2026-08-10T19:00:00"), TZ, 19, null)).toBe(true);
    expect(deveEnviarResumo(local("2026-08-10T08:00:00"), TZ, 19, null)).toBe(false);
  });

  // O "dia" é o da CLÍNICA, não o do servidor. Às 23h de São Paulo já é o dia
  // seguinte em UTC — comparar no fuso errado mandaria dois resumos numa data e
  // nenhum na outra.
  it("usa o fuso da clínica para decidir a hora e o dia", () => {
    // 11:00 UTC = 08:00 em São Paulo.
    expect(deveEnviarResumo(new Date("2026-08-10T11:00:00Z"), TZ, 8, null)).toBe(true);
    // 08:00 UTC = 05:00 em São Paulo.
    expect(deveEnviarResumo(new Date("2026-08-10T08:00:00Z"), TZ, 8, null)).toBe(false);
  });

  it("o padrão da hora é o documentado", () => {
    expect(HORA_PADRAO).toBe(8);
  });
});
