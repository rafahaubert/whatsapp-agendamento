import { describe, it, expect } from "vitest";
import { envolverEmPagina, carregarProposta } from "../../src/marketing/proposta.js";

describe("envolverEmPagina", () => {
  it("entrega uma página completa, e não um fragmento", () => {
    const html = envolverEmPagina("<p>oi</p>");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<p>oi</p>");
  });

  it("declara o charset — a proposta é toda acentuada", () => {
    expect(envolverEmPagina("")).toContain('<meta charset="utf-8">');
  });

  it("declara a viewport — sem ela o material abre reduzido no celular", () => {
    expect(envolverEmPagina("")).toContain('name="viewport"');
  });
});

describe("carregarProposta", () => {
  it("lê o arquivo real da proposta", async () => {
    const html = await carregarProposta();
    expect(html).toContain("HAUBERT AGENTS");
    expect(html).toContain("Sua recepção foi para casa.");
    // o lockup vem de <symbol> embutidos: sem eles a marca some
    expect(html).toContain('id="m-haubert"');
  });
});
