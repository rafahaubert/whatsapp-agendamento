import { describe, it, expect, beforeEach } from "vitest";
import { loginBloqueado, registrarFalha, limparTentativas } from "../../src/admin/auth.js";

const chave = "teste@clinica.com|1.2.3.4";
const agora = Date.now();

beforeEach(() => limparTentativas(chave));

describe("proteção contra força bruta no login", () => {
  it("libera enquanto as tentativas estão abaixo do limite", () => {
    for (let i = 0; i < 7; i++) registrarFalha(chave, agora);
    expect(loginBloqueado(chave, agora)).toBe(false);
  });

  it("bloqueia ao atingir o limite", () => {
    for (let i = 0; i < 8; i++) registrarFalha(chave, agora);
    expect(loginBloqueado(chave, agora)).toBe(true);
  });

  it("libera de novo depois que a janela expira", () => {
    for (let i = 0; i < 10; i++) registrarFalha(chave, agora);
    expect(loginBloqueado(chave, agora)).toBe(true);
    const depois = agora + 16 * 60 * 1000; // 16 min
    expect(loginBloqueado(chave, depois)).toBe(false);
  });

  it("login bem-sucedido zera o contador", () => {
    for (let i = 0; i < 8; i++) registrarFalha(chave, agora);
    limparTentativas(chave);
    expect(loginBloqueado(chave, agora)).toBe(false);
  });

  it("conta por identificador — bloquear um não afeta o outro", () => {
    const outra = "outro@clinica.com|9.9.9.9";
    for (let i = 0; i < 8; i++) registrarFalha(chave, agora);
    expect(loginBloqueado(chave, agora)).toBe(true);
    expect(loginBloqueado(outra, agora)).toBe(false);
  });
});
