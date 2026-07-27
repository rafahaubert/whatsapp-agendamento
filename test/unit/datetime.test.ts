import { describe, it, expect } from "vitest";
import { formatDateTime } from "../../src/shared/datetime.js";

describe("formatDateTime", () => {
  it("formata no fuso de São Paulo (UTC-3) em pt-BR", () => {
    // 17:30 UTC = 14:30 em America/Sao_Paulo
    const d = new Date("2026-07-24T17:30:00Z");
    const s = formatDateTime(d, "America/Sao_Paulo");
    expect(s).toContain("14:30");
    expect(s).toContain("24/07");
  });
});
