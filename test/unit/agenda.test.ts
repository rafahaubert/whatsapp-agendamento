import { describe, it, expect } from "vitest";
import { resumoAgenda } from "../../src/domain/scheduling.js";
import { statusUI } from "../../src/shared/enums.js";

describe("resumoAgenda", () => {
  it("agrupa dias com o mesmo horário", () => {
    const dias = {
      0: null,
      1: { open: "08:30", close: "22:30" },
      2: { open: "08:30", close: "22:30" },
      3: { open: "08:30", close: "22:30" },
      4: { open: "08:30", close: "22:30" },
      5: { open: "08:30", close: "22:30" },
      6: null,
    };
    expect(resumoAgenda(dias)).toBe("seg, ter, qua, qui, sex: 08:30 às 22:30");
  });

  it("separa faixas diferentes", () => {
    const dias = {
      0: null,
      1: { open: "08:00", close: "12:00" },
      2: null,
      3: { open: "14:00", close: "18:00" },
      4: null,
      5: null,
      6: null,
    };
    expect(resumoAgenda(dias)).toBe("seg: 08:00 às 12:00 · qua: 14:00 às 18:00");
  });

  it("avisa quando não há dias definidos", () => {
    const vazio = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
    expect(resumoAgenda(vazio)).toMatch(/sem dias/);
  });
});

describe("statusUI", () => {
  it("traduz os status conhecidos", () => {
    expect(statusUI("SCHEDULED").label).toBe("Agendado");
    expect(statusUI("CANCELLED").label).toBe("Cancelado");
    expect(statusUI("NO_SHOW").css).toBe("st-faltou");
  });

  it("não quebra com status desconhecido", () => {
    expect(statusUI("XPTO").label).toBe("XPTO");
  });
});
