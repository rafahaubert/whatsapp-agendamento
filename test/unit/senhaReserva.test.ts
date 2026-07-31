import { describe, it, expect } from "vitest";
import { hashSenha, verificarSenha } from "../../src/admin/auth.js";

/**
 * O `autenticar` toca o banco, então o que dá para cobrir sem integração é o
 * formato do hash da chave reserva — que é o mesmo dos usuários do painel.
 * O caminho completo de login com ADMIN_PASSWORD_HASH está em
 * test/integration/auth.test.ts.
 */
describe("hash da senha reserva (ADMIN_PASSWORD_HASH)", () => {
  it("gera no formato salt:hash que o env espera", async () => {
    const hash = await hashSenha("minhaSenhaForte123");
    const [salt, derivada] = hash.split(":");
    expect(salt).toHaveLength(32); // 16 bytes em hex
    expect(derivada).toHaveLength(128); // 64 bytes em hex
  });

  it("nunca produz o mesmo hash duas vezes (salt aleatório)", async () => {
    const a = await hashSenha("mesmaSenha");
    const b = await hashSenha("mesmaSenha");
    expect(a).not.toBe(b);
    // …mas as duas conferem contra a mesma senha.
    expect(await verificarSenha("mesmaSenha", a)).toBe(true);
    expect(await verificarSenha("mesmaSenha", b)).toBe(true);
  });

  it("aceita a senha certa e rejeita a errada", async () => {
    const hash = await hashSenha("senhaCorreta");
    expect(await verificarSenha("senhaCorreta", hash)).toBe(true);
    expect(await verificarSenha("senhaErrada", hash)).toBe(false);
  });

  it("rejeita valor malformado em vez de estourar", async () => {
    expect(await verificarSenha("x", "sem-dois-pontos")).toBe(false);
    expect(await verificarSenha("x", "")).toBe(false);
    expect(await verificarSenha("x", ":")).toBe(false);
  });
});
