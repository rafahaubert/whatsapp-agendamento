import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

interface AdminSession {
  user?: string;
}

function sess(req: Request): AdminSession {
  return req.session as unknown as AdminSession;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Compara credenciais do formulário com as do ambiente (tempo constante). */
export function checkCredentials(user: string, password: string): boolean {
  return safeEqual(user, env.ADMIN_USER) && safeEqual(password, env.ADMIN_PASSWORD);
}

export function isLoggedIn(req: Request): boolean {
  return Boolean(sess(req).user);
}

export function login(req: Request, user: string): void {
  sess(req).user = user;
}

export function logout(req: Request): void {
  sess(req).user = undefined;
}

/** Middleware: barra o acesso a quem não está logado. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isLoggedIn(req)) return next();
  res.redirect("/admin/login");
}
