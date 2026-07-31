import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { prisma } from "../db/client.js";
import { logger } from "../shared/logger.js";
import { Role } from "../shared/enums.js";
import { safeEqual } from "../shared/comparacao.js";

const scrypt = promisify(crypto.scrypt) as (
  senha: string,
  salt: string,
  tamanho: number,
) => Promise<Buffer>;

// O papel mora em shared/enums para as regras de permissão não arrastarem
// ambiente e banco junto. Re-exportado aqui por conveniência de quem já importa.
export { Role } from "../shared/enums.js";

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
 * Confere a senha da chave reserva do ambiente.
 *
 * `ADMIN_PASSWORD_HASH` tem precedência: guardar a senha em texto plano expõe
 * ela no dashboard do provedor, em `fly secrets list`, em dumps de ambiente e em
 * qualquer lugar onde a config vaze. O hash é scrypt, o mesmo formato usado para
 * os usuários do banco.
 *
 * `ADMIN_PASSWORD` continua aceita para não quebrar quem já está no ar; o aviso
 * de startup indica a migração.
 */
async function senhaReservaConfere(senha: string): Promise<boolean> {
  if (env.ADMIN_PASSWORD_HASH) return verificarSenha(senha, env.ADMIN_PASSWORD_HASH);
  if (env.ADMIN_PASSWORD) return safeEqual(senha, env.ADMIN_PASSWORD);
  return false; // config/env.ts barra este caso no boot
}

/**
 * Autentica pelo banco (o identificador é o E-MAIL do usuário).
 *
 * As credenciais do ambiente (ADMIN_USER/ADMIN_PASSWORD) continuam valendo como
 * SUPER mesmo depois de existirem usuários cadastrados: são a chave reserva do
 * operador. Antes elas só funcionavam com a tabela vazia, então criar o
 * primeiro usuário trancava todo mundo do lado de fora do painel — sem nenhuma
 * forma de voltar a entrar. Um usuário do banco com o mesmo identificador tem
 * prioridade, para que trocar a senha pelo painel valha de verdade.
 */
export async function autenticar(
  email: string,
  senha: string,
): Promise<UsuarioAutenticado | null> {
  const identificador = email.trim();

  const user = await prisma.adminUser.findUnique({
    where: { email: identificador.toLowerCase() },
  });

  if (user) {
    if (!user.isActive) return null;
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

  if (safeEqual(identificador, env.ADMIN_USER) && (await senhaReservaConfere(senha))) {
    logger.warn({ user: env.ADMIN_USER }, "login pela credencial do ambiente (chave reserva)");
    return { userId: "bootstrap", nome: env.ADMIN_USER, role: Role.SUPER, tenantId: null };
  }

  return null;
}

export function isLoggedIn(req: Request): boolean {
  return Boolean(sess(req).userId);
}

/**
 * Grava o usuário na sessão com um ID NOVO (session fixation).
 *
 * Sem `regenerate`, o ID de sessão de antes do login continua valendo depois
 * dele: quem conseguisse plantar um cookie conhecido no navegador da vítima
 * (link com o ID, XSS em subdomínio) passaria a estar logado junto com ela.
 * `regenerate` descarta o ID antigo e emite outro, então o cookie plantado
 * morre no momento do login.
 */
export function login(req: Request, user: UsuarioAutenticado): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      const s = sess(req);
      s.userId = user.userId;
      s.nome = user.nome;
      s.role = user.role;
      s.tenantId = user.tenantId;
      // Persiste antes de responder para o redirect já chegar autenticado.
      req.session.save((erroSave) => (erroSave ? reject(erroSave) : resolve()));
    });
  });
}

/**
 * Destrói a sessão no store, em vez de só apagar os campos. Antes o registro
 * continuava existindo (e o cookie válido) após o logout — agora o ID é
 * invalidado do lado do servidor.
 */
export function logout(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
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
