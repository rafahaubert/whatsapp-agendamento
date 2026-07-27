import { describe, it, expect } from "vitest";
import { podeGerenciarUsuarioDaClinica } from "../../src/admin/permissoes.js";
import { Role } from "../../src/shared/enums.js";

const CLINICA = "cl_1";
const OUTRA = "cl_2";

const admDaClinica = { userId: "u_adm", role: Role.CLINIC };
const superAdmin = { userId: "u_super", role: Role.SUPER };

const recepcao = { id: "u_rec", role: Role.CLINIC, tenantId: CLINICA };
const deOutraClinica = { id: "u_out", role: Role.CLINIC, tenantId: OUTRA };
const plataforma = { id: "u_super2", role: Role.SUPER, tenantId: null };

describe("podeGerenciarUsuarioDaClinica", () => {
  it("libera o admin da clínica sobre a própria recepção", () => {
    expect(podeGerenciarUsuarioDaClinica(admDaClinica, CLINICA, recepcao)).toEqual({ ok: true });
  });

  // requireTenant confere o :id da URL, não o alvo: sem esta trava bastaria
  // mandar o userId de outra clínica no corpo do POST.
  it("barra alvo de outra clínica mesmo com a URL da própria", () => {
    const r = podeGerenciarUsuarioDaClinica(admDaClinica, CLINICA, deOutraClinica);
    expect(r.ok).toBe(false);
  });

  it("barra alvo sem clínica nenhuma", () => {
    const r = podeGerenciarUsuarioDaClinica(admDaClinica, CLINICA, {
      id: "u_x",
      role: Role.CLINIC,
      tenantId: null,
    });
    expect(r.ok).toBe(false);
  });

  it("barra mexer num usuário da plataforma", () => {
    expect(podeGerenciarUsuarioDaClinica(admDaClinica, CLINICA, plataforma).ok).toBe(false);
    // e nem o super se gerencia por aqui
    expect(podeGerenciarUsuarioDaClinica(superAdmin, CLINICA, plataforma).ok).toBe(false);
  });

  it("barra o SUPER de escalar alguém de outra clínica pela tela da clínica", () => {
    expect(podeGerenciarUsuarioDaClinica(superAdmin, CLINICA, deOutraClinica).ok).toBe(false);
  });

  it("ninguém desativa ou exclui o próprio acesso", () => {
    const eu = { id: "u_adm", role: Role.CLINIC, tenantId: CLINICA };
    const r = podeGerenciarUsuarioDaClinica(admDaClinica, CLINICA, eu);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/próprio acesso/i);
  });

  it("o super pode gerenciar a recepção de uma clínica", () => {
    expect(podeGerenciarUsuarioDaClinica(superAdmin, CLINICA, recepcao)).toEqual({ ok: true });
  });

  it("ator sem sessão identificada não trava a regra de alvo", () => {
    // Sem userId não dá para comparar "sou eu mesmo"; as demais travas seguem valendo.
    expect(podeGerenciarUsuarioDaClinica({ role: Role.CLINIC }, CLINICA, recepcao)).toEqual({
      ok: true,
    });
    expect(podeGerenciarUsuarioDaClinica({ role: Role.CLINIC }, CLINICA, deOutraClinica).ok).toBe(
      false,
    );
  });
});
