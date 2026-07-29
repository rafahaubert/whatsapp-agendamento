import { describe, it, expect } from "vitest";
import { casarNome, normalizarNome } from "../../src/shared/nomes.js";

const josue = { name: "Josué Santana" };
const maria = { name: "Maria Santana" };

describe("normalizarNome", () => {
  it("ignora acento, caixa e pontuação", () => {
    expect(normalizarNome("José Antônio")).toBe(normalizarNome("jose  antonio"));
    expect(normalizarNome("D'Ávila-Souza")).toBe("d avila souza");
  });
});

describe("casarNome", () => {
  it("acha pelo nome completo", () => {
    expect(casarNome([josue, maria], "josue santana")).toBe(josue);
  });

  it("acha pelo primeiro nome, que é como o paciente responde", () => {
    expect(casarNome([josue, maria], "Maria")).toBe(maria);
  });

  it("acha quando o cadastro tem só o primeiro nome e ele dá o completo", () => {
    const ana = { name: "Ana" };
    expect(casarNome([ana], "Ana Paula Ribeiro")).toBe(ana);
  });

  it("na ambiguidade não escolhe — quem chamou pede o CPF", () => {
    const outraMaria = { name: "Maria Oliveira" };
    expect(casarNome([maria, outraMaria], "Maria")).toBeUndefined();
    expect(casarNome([{ name: "Ana" }, { name: "Ana" }], "Ana")).toBeUndefined();
  });

  it("nome de fora da lista não casa com ninguém", () => {
    expect(casarNome([josue, maria], "Pedro")).toBeUndefined();
    expect(casarNome([josue], "")).toBeUndefined();
    expect(casarNome([], "Josué")).toBeUndefined();
  });
});
