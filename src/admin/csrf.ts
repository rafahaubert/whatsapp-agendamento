import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { safeEqual } from "../shared/comparacao.js";
import { logger } from "../shared/logger.js";

/** Nome do campo escondido nos forms e do header usado pelos fetch do painel. */
export const CAMPO_CSRF = "_csrf";
export const HEADER_CSRF = "x-csrf-token";

/** Métodos que não alteram estado — não exigem token. */
const METODOS_SEGUROS = new Set(["GET", "HEAD", "OPTIONS"]);

interface SessaoComCsrf {
  csrfToken?: string;
}

/**
 * Token de CSRF da sessão (padrão synchronizer token), criado na primeira
 * chamada e reusado depois. Vive na sessão, então um atacante em outro site não
 * consegue lê-lo: ele consegue fazer o navegador ENVIAR o cookie, mas não ler o
 * corpo da resposta que traz o token.
 */
export function csrfToken(req: Request): string {
  const s = req.session as unknown as SessaoComCsrf;
  if (!s.csrfToken) s.csrfToken = crypto.randomBytes(32).toString("hex");
  return s.csrfToken;
}

/**
 * Publica o token em `res.locals.csrf` para as views (partials/csrf.ejs) e no
 * header da resposta, de onde o JavaScript do próprio painel pode lê-lo.
 */
export function exposeCsrf(req: Request, res: Response, next: NextFunction): void {
  const token = csrfToken(req);
  res.locals.csrf = token;
  res.setHeader(HEADER_CSRF, token);
  next();
}

/**
 * Exige o token em toda requisição que altera estado.
 *
 * Antes disto a única defesa era `sameSite: "lax"` no cookie. Isso de fato
 * bloqueia POST cross-site nos navegadores atuais, mas era defesa única: uma
 * regressão que afrouxasse o sameSite, um subdomínio comprometido ou um
 * navegador antigo reabriam CSRF total — inclusive em POST /admin/usuarios, que
 * cria usuário SUPER, e em POST /admin/usuarios/:id/senha, que troca senha.
 */
export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  if (METODOS_SEGUROS.has(req.method)) return next();

  const esperado = (req.session as unknown as SessaoComCsrf)?.csrfToken;
  const corpo = req.body as Record<string, unknown> | undefined;
  const enviado =
    (typeof corpo?.[CAMPO_CSRF] === "string" ? (corpo[CAMPO_CSRF] as string) : undefined) ??
    req.header(HEADER_CSRF);

  if (esperado && enviado && safeEqual(enviado, esperado)) return next();

  logger.warn(
    { ip: req.ip, path: req.originalUrl, metodo: req.method, tinhaToken: Boolean(enviado) },
    "requisição rejeitada por falha de CSRF",
  );

  // O fetch do calendário espera JSON; os forms esperam HTML. Decide pelo
  // Content-Type da requisição, não pelo Accept — `fetch` manda `Accept: */*`,
  // que casaria com HTML e faria o `r.json()` do cliente estourar.
  if (req.is("json")) {
    res.status(403).json({ erro: "Sessão expirada ou token inválido. Recarregue a página." });
    return;
  }

  res.status(403).render("admin/erro", {
    titulo: "Sessão expirada",
    mensagem:
      "Não foi possível validar o envio deste formulário. " +
      "Isso costuma acontecer quando a página ficou aberta por muito tempo. " +
      "Volte, recarregue a página e tente de novo.",
  });
}
