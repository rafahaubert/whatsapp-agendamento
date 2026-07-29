import { describe, it, expect } from "vitest";
import { resumoAgenda } from "../../src/domain/scheduling.js";
import { pontaDaJanela } from "../../src/jobs/agenda.js";
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

  it("mostra o intervalo de almoço — ele decide quais horários existem", () => {
    // "08:00 às 18:00" com almoço até as 18:00 não tem tarde nenhuma. Esconder
    // o intervalo fazia o painel e o system prompt anunciarem uma tarde que o
    // gerador nunca produziu.
    const dias = {
      0: null,
      1: { open: "08:00", close: "18:00", breakStart: "12:00", breakEnd: "18:00" },
      2: null, 3: null, 4: null, 5: null, 6: null,
    };
    expect(resumoAgenda(dias)).toBe("seg: 08:00 às 18:00 (almoço 12:00–18:00)");
  });

  it("ignora intervalo inválido (fim antes do início), como o gerador", () => {
    const dias = {
      0: null,
      1: { open: "08:00", close: "18:00", breakStart: "13:00", breakEnd: "12:00" },
      2: null, 3: null, 4: null, 5: null, 6: null,
    };
    expect(resumoAgenda(dias)).toBe("seg: 08:00 às 18:00");
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

describe("pontaDaJanela", () => {
  const agora = new Date("2026-07-30T12:00:00.000Z");
  const dias = (d: Date) => Math.round((d.getTime() - agora.getTime()) / 86_400_000);

  it("aponta um dia antes do fim da janela", () => {
    // A folga de um dia é o relógio da renovação: a janela recua um dia por dia,
    // então o teste falha sozinho uma vez ao dia e a agenda se refaz — sem
    // precisar guardar "quando foi a última vez".
    expect(dias(pontaDaJanela(30, agora)!)).toBe(29);
    expect(dias(pontaDaJanela(7, agora)!)).toBe(6);
  });

  it("janela curta demais não tem atalho: renova sempre", () => {
    expect(pontaDaJanela(1, agora)).toBeNull();
    expect(pontaDaJanela(0, agora)).toBeNull();
  });
});
