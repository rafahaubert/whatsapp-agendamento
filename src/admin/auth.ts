import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { prisma } from "../db/client.js";

const scrypt = promisify(crypto.scrypt) as (
  senha: string,
  salt: string,
  tamanho: number,
) => Promise<Buffer>;

export const Role = { SUPER: "SUPER", CLINIC: "CLINIC" } as const;
export type Role = (typeof Role)[keyof typeof Role];

export interface AdminSession {
  userId?: string;
  nome?: string;
  role?: Role;
  /** Definido apenas para usuários de clínica. */
  tenantId?: string | null;
}

function sess(req: Request): AdminSession {
  return req.session as unknown as AdminSession;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- Senhas (scrypt nativo — sem dependência extra) ----------

export async function hashSenha(senha: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivada = await scrypt(senha, salt, 64);
  return `${salt}:${derivada.toString("hex")}`;
}

export async function verificarSenha(senha: string, guardada: string): Promise<boolean> {
  const [salt, hash] = guardada.split(":");
  if (!salt || !hash) return false;
  const derivada = await scrypt(senha, salt, 64);
  return safeEqual(derivada.toString("hex"), hash);
}

// ---------- Proteção contra força bruta ----------

/**
 * Limita tentativas de login por identificador (e-mail + IP). Em memória:
 * suficiente para uma instância e sem dependência nova. Se um dia houver
 * várias instâncias, trocar por um contador no banco/Redis.
 */
const TENTATIVAS_MAX = 8;
const JANELA_MS = 15 * 60 * 1000;
const tentativas = new Map<string, { n: number; ate: number }>();

export function loginBloqueado(chave: string, agora = Date.now()): boolean {
  const t = tentativas.get(chave);
  if (!t) return false;
  if (agora > t.ate) {
    tentativas.delete(chave);
    return false;
  }
  return t.n >= TENTATIVAS_MAX;
}

export function registrarFalha(chave: string, agora = Date.now()): void {
  const t = tentativas.get(chave);
  if (!t || agora > t.ate) {
    tentativas.set(chave, { n: 1, ate: agora + JANELA_MS });
    return;
  }
  t.n += 1;
}

export function limparTentativas(chave: string): void {
  tentativas.delete(chave);
}

// ---------- Login ----------

export interface UsuarioAutenticado {
  userId: string;
  nome: string;
  role: Role;
  tenantId: string | null;
}

/**
 * Autentica pelo banco. Enquanto NÃO existir nenhum usuário cadastrado, aceita
 * as credenciais do ambiente como SUPER — assim ninguém fica trancado fora do
 * painel logo após o deploy.
 */
export async function autenticar(
  email: string,
  senha: string,
): Promise<UsuarioAutenticado | null> {
  const total = await prisma.adminUser.count();

  if (total === 0) {
    const ok = safeEqual(email, env.ADMIN_USER) && safeEqual(senha, env.ADMIN_PASSWORD);
    return ok ? { userId: "bootstrap", nome: env.ADMIN_USER, role: Role.SUPER, tenantId: null } : null;
  }

  const user = await prisma.adminUser.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!user || !user.isActive) return null;
  if (!(await verificarSenha(senha, user.passwordHash))) return null;

  await prisma.adminUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    userId: user.id,
    nome: user.name,
    role: user.role as Role,
    tenantId: user.tenantId,
  };
}

export function isLoggedIn(req: Request): boolean {
  return Boolean(sess(req).userId);
}

export function login(req: Request, user: UsuarioAutenticado): void {
  const s = sess(req);
  s.userId = user.userId;
  s.nome = user.nome;
  s.role = user.role;
  s.tenantId = user.tenantId;
}

export function logout(req: Request): void {
  const s = sess(req);
  s.userId = undefined;
  s.nome = undefined;
  s.role = undefined;
  s.tenantId = undefined;
}

export function usuarioAtual(req: Request): AdminSession {
  return sess(req);
}

export function ehSuper(req: Request): boolean {
  return sess(req).role === Role.SUPER;
}

// ---------- Middlewares ----------

/** Barra quem não está logado. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isLoggedIn(req)) return next();
  res.redirect("/admin/login");
}

/** Só o operador da plataforma (SUPER). */
export function requireSuper(req: Request, res: Response, next: NextFunction): void {
  if (ehSuper(req)) return next();
  res.status(403).render("admin/erro", {
    titulo: "Acesso restrito",
    mensagem: "Esta área é exclusiva do administrador da plataforma.",
  });
}

/**
 * Isolamento entre clínicas: um usuário CLINIC só acessa a própria clínica.
 * Usa o parâmetro :id da rota.
 */
export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  const s = sess(req);
  if (s.role === Role.SUPER) return next();
  if (s.tenantId && req.params.id === s.tenantId) return next();

  res.status(403).render("admin/erro", {
    titulo: "Acesso negado",
    mensagem: "Você não tem permissão para acessar os dados desta clínica.",
  });
}
