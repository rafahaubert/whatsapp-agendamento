import { describe, it, expect } from "vitest";
import { titulosUnicos } from "../../src/channels/whatsapp/client.js";

describe("titulosUnicos", () => {
  it("mantém títulos já distintos", () => {
    const r = titulosUnicos(
      [
        { id: "a", titulo: "seg., 27/07, 08:30" },
        { id: "b", titulo: "seg., 27/07, 09:00" },
      ],
      20,
    );
    expect(r.map((o) => o.titulo)).toEqual(["seg., 27/07, 08:30", "seg., 27/07, 09:00"]);
  });

  // Era exatamente o erro 131009 "Duplicate button title" da Meta.
  it("desduplica títulos iguais (dois profissionais no mesmo horário)", () => {
    const r = titulosUnicos(
      [
        { id: "a", titulo: "seg., 27/07, 08:30" },
        { id: "b", titulo: "seg., 27/07, 08:30" },
        { id: "c", titulo: "seg., 27/07, 08:30" },
      ],
      20,
    );
    expect(new Set(r.map((o) => o.titulo)).size).toBe(3);
  });

  it("desduplica mesmo quando o corte deixaria os títulos iguais", () => {
    const r = titulosUnicos(
      [
        { id: "a", titulo: "Ortodontia com aparelho fixo metálico" },
        { id: "b", titulo: "Ortodontia com aparelho fixo estético" },
      ],
      20,
    );
    expect(new Set(r.map((o) => o.titulo)).size).toBe(2);
    r.forEach((o) => expect(o.titulo.length).toBeLessThanOrEqual(20));
  });

  it("respeita o limite de caracteres", () => {
    const r = titulosUnicos([{ id: "a", titulo: "x".repeat(50) }], 24);
    expect(r[0].titulo.length).toBeLessThanOrEqual(24);
  });
});
