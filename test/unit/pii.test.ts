import { describe, it, expect } from "vitest";
import { mascararTelefone, mascararIdentificador } from "../../src/shared/pii.js";

describe("mascararTelefone", () => {
  it("preserva DDI/DDD e os 4 últimos dígitos", () => {
    expect(mascararTelefone("+5551999887766")).toBe("+5551****7766");
  });

  it("nunca devolve o número inteiro", () => {
    const numero = "+5551999887766";
    const mascarado = mascararTelefone(numero);
    expect(mascarado).not.toBe(numero);
    expect(mascarado).not.toContain("99988"); // o miolo do número não aparece
  });

  it("trata ausência e valores curtos sem vazar o valor cru", () => {
    expect(mascararTelefone(null)).toBe("(sem telefone)");
    expect(mascararTelefone(undefined)).toBe("(sem telefone)");
    expect(mascararTelefone("")).toBe("(sem telefone)");
    expect(mascararTelefone("1234")).toBe("***");
    expect(mascararTelefone("12345678")).toBe("***");
  });
});

describe("mascararIdentificador", () => {
  it("mantém o domínio do e-mail, corta o resto", () => {
    expect(mascararIdentificador("rafael@gmail.com")).toBe("raf***@gmail.com");
  });

  it("corta o que não é e-mail — protege senha digitada no campo errado", () => {
    expect(mascararIdentificador("minhaSenhaSecreta123")).toBe("min***");
  });

  it("não vaza o local part curto por inteiro", () => {
    expect(mascararIdentificador("ab@x.com")).toBe("ab***@x.com");
  });

  it("trata vazio", () => {
    expect(mascararIdentificador(null)).toBe("(vazio)");
    expect(mascararIdentificador("")).toBe("(vazio)");
  });
});
