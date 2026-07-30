import rateLimit, { type Options } from "express-rate-limit";
import { logger } from "./logger.js";

/**
 * Limitadores de taxa por IP.
 *
 * Store em memória (o padrão): coerente com o desenho de instância única deste
 * serviço — `fly.toml` fixa `min_machines_running = 1` e o Render free sobe uma
 * só. Com 2+ instâncias cada uma contaria em separado, e o teto efetivo viraria
 * N vezes o configurado; nesse cenário, trocar por um store compartilhado.
 */

function base(nome: string, windowMs: number, limit: number): Partial<Options> {
  return {
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ ip: req.ip, path: req.originalUrl, limite: nome }, "rate limit atingido");
      res.status(429).json({ erro: "Muitas requisições. Tente novamente em instantes." });
    },
  };
}

/**
 * Webhook da Meta. Teto alto: um número de WhatsApp movimentado gera rajadas
 * legítimas, e cada mensagem processada custa tokens da Anthropic. Serve para
 * conter flood, não para modelar tráfego normal.
 *
 * Montado DEPOIS da validação HMAC, para que requisição não assinada seja
 * descartada antes de ocupar espaço no contador.
 */
export const limiteWebhook = rateLimit(base("webhook", 60_000, 300));

/** Jobs por cron externo: poucas chamadas por hora, sempre do mesmo lugar. */
export const limiteJobs = rateLimit(base("jobs", 60_000, 10));

/**
 * Login do painel. Complementa (não substitui) o contador de
 * `src/admin/auth.ts`, que é por `usuário|IP`: este é por IP puro, então também
 * cobre enumeração de usuários — tentar uma senha em muitas contas diferentes
 * nunca chegava ao teto por usuário.
 */
export const limiteLogin = rateLimit({
  ...base("login", 15 * 60_000, 30),
  skipSuccessfulRequests: true, // quem acerta a senha não é penalizado
  // O login é um form, não um fetch: devolver JSON deixaria a tela em branco.
  // Reusa a mensagem de bloqueio que a própria página já sabe exibir.
  handler: (req, res) => {
    logger.warn({ ip: req.ip, limite: "login" }, "rate limit atingido");
    res.redirect("/admin/login?erro=bloqueado");
  },
});
