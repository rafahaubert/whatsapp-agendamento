import { describe, it, expect } from "vitest";
import { normalizeCpf, isValidCpf } from "../../src/shared/cpf.js";

describe("normalizeCpf", () => {
  it("remove pontuação", () => {
    expect(normalizeCpf("529.982.247-25")).toBe("52998224725");
  });
});

describe("isValidCpf", () => {
  it("aceita um CPF válido", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
  });

  it("rejeita dígitos verificadores errados", () => {
    expect(isValidCpf("529.982.247-24")).toBe(false);
  });

  it("rejeita quantidade errada de dígitos", () => {
    expect(isValidCpf("123")).toBe(false);
  });

  it("rejeita todos os dígitos iguais", () => {
    expect(isValidCpf("111.111.111-11")).toBe(false);
  });
});
