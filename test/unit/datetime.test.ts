import { describe, it, expect } from "vitest";
import {
  formatDateTime,
  formatarHoraCurta,
  parseDataHoraLocal,
} from "../../src/shared/datetime.js";

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

describe("parseDataHoraLocal", () => {
  it("lê o datetime-local no fuso da clínica, não no do servidor", () => {
    // O container de produção roda em UTC: `new Date("2026-07-31T14:00")` daria
    // 14:00Z, ou seja, 11:00 em São Paulo — três horas de diferença em tudo que
    // a recepção digita.
    const d = parseDataHoraLocal("2026-07-31T14:00", "America/Sao_Paulo");
    expect(d?.toISOString()).toBe("2026-07-31T17:00:00.000Z");
  });

  it("segue o fuso informado", () => {
    const d = parseDataHoraLocal("2026-07-31T14:00", "America/Manaus");
    expect(d?.toISOString()).toBe("2026-07-31T18:00:00.000Z");
  });

  it("respeita o fuso que a própria string carrega (calendário arrastado)", () => {
    const d = parseDataHoraLocal("2026-07-31T17:00:00.000Z", "America/Sao_Paulo");
    expect(d?.toISOString()).toBe("2026-07-31T17:00:00.000Z");
  });

  it("aceita segundos e o formato com espaço do input", () => {
    expect(parseDataHoraLocal("2026-07-31T14:00:00", "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-07-31T17:00:00.000Z",
    );
  });

  it("devolve null para valor vazio ou inválido", () => {
    expect(parseDataHoraLocal("", "America/Sao_Paulo")).toBeNull();
    expect(parseDataHoraLocal("   ", "America/Sao_Paulo")).toBeNull();
    expect(parseDataHoraLocal("não é data", "America/Sao_Paulo")).toBeNull();
    expect(parseDataHoraLocal(null, "America/Sao_Paulo")).toBeNull();
  });
});
