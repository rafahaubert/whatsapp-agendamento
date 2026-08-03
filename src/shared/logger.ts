import pino from "pino";
import { env } from "../config/env.js";
import { contextoAtual } from "./contexto.js";

const emProducao = env.NODE_ENV === "production";

/**
 * Segredos: redigidos SEMPRE, em qualquer ambiente. Não existe motivo legítimo
 * para um token ou senha aparecer no log, nem em desenvolvimento.
 */
const SEGREDOS = [
  "password",
  "senha",
  "passwordHash",
  "token",
  "accessToken",
  "apiKey",
  "secret",
  "authorization",
  "cookie",
];

/**
 * Dados pessoais de paciente: redigidos só em produção (LGPD). Em
 * desenvolvimento continuam visíveis, porque rastrear uma conversa pelo telefone
 * é justamente como se depura este sistema.
 */
const DADOS_PESSOAIS = ["cpf", "phone", "telefone", "patientPhone", "paciente"];

/**
 * Rede de segurança para o caso de um objeto de erro arrastar a requisição
 * inteira — `logger.error({ err })` onde `err` carrega `err.req.headers` é fácil
 * de escrever sem perceber, e é aí que a chave da Anthropic ou o token da Meta
 * vazam. O certo continua sendo não passar o campo ao logger; isto é o cinto.
 */
const HEADERS = [
  "authorization",
  "cookie",
  '["x-jobs-token"]',
  '["x-hub-signature-256"]',
  '["x-csrf-token"]',
];

const campos = emProducao ? [...SEGREDOS, ...DADOS_PESSOAIS] : SEGREDOS;

const paths = [
  // `*.campo` casa em qualquer profundidade; `campo` casa na raiz do log.
  ...campos.flatMap((c) => [c, `*.${c}`]),
  ...HEADERS.flatMap((h) => {
    const sufixo = h.startsWith("[") ? h : `.${h}`;
    return [`req.headers${sufixo}`, `headers${sufixo}`];
  }),
];

/**
 * Logger estruturado. Em produção emite JSON (fácil de ingerir em Datadog,
 * Loki, CloudWatch, etc.). Em desenvolvimento usa pino-pretty (legível).
 */
export const logger = pino({
  level: emProducao ? "info" : "debug",
  redact: { paths, censor: "[REDACTED]" },
  /**
   * Costura as linhas de UMA mensagem do paciente.
   *
   * Vem do `AsyncLocalStorage` (src/shared/contexto.ts), então nenhuma chamada
   * a `logger.info` precisou mudar — nem as camadas de domínio precisam saber
   * que existe um id de correlação. Sem isto, investigar uma conversa que deu
   * errado era garimpar por timestamp e torcer para nenhuma outra estar
   * acontecendo ao mesmo tempo.
   */
  mixin() {
    const ctx = contextoAtual();
    return ctx ? { correlacao: ctx.correlacao, ...(ctx.tenant ? { tenant: ctx.tenant } : {}) } : {};
  },
  transport: emProducao
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});
