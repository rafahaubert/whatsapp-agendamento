import { describe, it, expect } from "vitest";
import { formatDateTime, formatarHoraCurta } from "../../src/shared/datetime.js";

describe("formatDateTime", () => {
  it("formata no fuso de São Paulo (UTC-3) em pt-BR", () => {
    // 17:30 UTC = 14:30 em America/Sao_Paulo
    const d = new Date("2026-07-24T17:30:00Z");
    const s = formatDateTime(d, "America/Sao_Paulo");
    expect(s).toContain("14:30");
    expect(s).toContain("24/07");
  });
});

describe("formatarHoraCurta", () => {
  it("mostra a hora que o paciente vê no WhatsApp, não a do servidor em UTC", () => {
    // Mensagem gravada às 02:09 UTC = 23:09 do dia anterior em São Paulo.
    const d = new Date("2026-07-27T02:09:29Z");
    expect(formatarHoraCurta(d, "America/Sao_Paulo")).toBe("26/07, 23:09");
  });

  it("respeita o fuso da clínica", () => {
    const d = new Date("2026-07-27T02:09:29Z");
    expect(formatarHoraCurta(d, "America/Manaus")).toBe("26/07, 22:09");
  });
});
