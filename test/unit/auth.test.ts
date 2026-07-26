import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { hashSenha, verificarSenha, requireTenant, requireSuper, Role } from "../../src/admin/auth.js";

// --- Senhas ---
describe("hash de senha", () => {
  it("aceita a senha correta", async () => {
    const hash = await hashSenha("senha-super-secreta");
    expect(await verificarSenha("senha-super-secreta", hash)).toBe(true);
  });

  it("rejeita a senha errada", async () => {
    const hash = await hashSenha("senha-super-secreta");
    expect(await verificarSenha("senha-errada", hash)).toBe(false);
  });

  it("gera hashes diferentes para a mesma senha (salt por usuário)", async () => {
    const a = await hashSenha("igual");
    const b = await hashSenha("igual");
    expect(a).not.toBe(b);
    expect(await verificarSenha("igual", a)).toBe(true);
    expect(await verificarSenha("igual", b)).toBe(true);
  });

  it("não quebra com hash malformado", async () => {
    expect(await verificarSenha("x", "lixo")).toBe(false);
    expect(await verificarSenha("x", "")).toBe(false);
  });
});

// --- Isolamento entre clínicas ---
function fakeReq(session: object, params: Record<string, string> = {}) {
  return { session, params } as unknown as Request;
}
function fakeRes() {
  const res = {
    statusCode: 0,
    renderizou: null as string | null,
    status(c: number) { this.statusCode = c; return this; },
    render(v: string) { this.renderizou = v; },
  };
  return res as unknown as Response & { statusCode: number; renderizou: string | null };
}

describe("requireTenant (isolamento entre clínicas)", () => {
  it("deixa o SUPER acessar qualquer clínica", () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();
    requireTenant(fakeReq({ role: Role.SUPER }, { id: "outra-clinica" }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("deixa a clínica acessar a PRÓPRIA", () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();
    requireTenant(fakeReq({ role: Role.CLINIC, tenantId: "c1" }, { id: "c1" }), res, next);
    expect(next).toHaveBeenCalled();
  });

  // O ponto crítico: uma clínica NUNCA pode ver dados de outra (LGPD).
  it("BLOQUEIA a clínica tentando acessar outra", () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();
    requireTenant(fakeReq({ role: Role.CLINIC, tenantId: "c1" }, { id: "c2" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("bloqueia sessão sem clínica vinculada", () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();
    requireTenant(fakeReq({ role: Role.CLINIC }, { id: "c1" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe("requireSuper", () => {
  it("libera o SUPER", () => {
    const next = vi.fn() as unknown as NextFunction;
    requireSuper(fakeReq({ role: Role.SUPER }), fakeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("bloqueia usuário de clínica", () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();
    requireSuper(fakeReq({ role: Role.CLINIC, tenantId: "c1" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
