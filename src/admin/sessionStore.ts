import { Store, type SessionData } from "express-session";
import { prisma } from "../db/client.js";
import { logger } from "../shared/logger.js";

/** Fallback de validade quando a sessão não tem `cookie.maxAge` (8h, igual ao cookie). */
const VALIDADE_PADRAO_MS = 1000 * 60 * 60 * 8;

/** Intervalo da poda de sessões expiradas. */
const PODA_INTERVALO_MS = 1000 * 60 * 60;

function expiraEm(sess: SessionData): Date {
  const expires = sess.cookie?.expires;
  if (expires) return new Date(expires);
  const maxAge = sess.cookie?.maxAge ?? VALIDADE_PADRAO_MS;
  return new Date(Date.now() + maxAge);
}

/**
 * Store de sessão em PostgreSQL, sobre o Prisma client que a aplicação já usa.
 *
 * Substitui o MemoryStore padrão do express-session, que tem dois problemas
 * concretos aqui: perde TODOS os logins do painel a cada deploy (o processo
 * reinicia e a RAM vai embora) e nunca libera as sessões expiradas, vazando
 * memória — o próprio express-session avisa que não é para produção.
 *
 * Escrito à mão em vez de usar connect-pg-simple para não abrir um segundo pool
 * de conexões ao banco: aquele pacote quer um `pg.Pool` próprio, enquanto aqui
 * reaproveitamos o pool do Prisma.
 */
export class PrismaSessionStore extends Store {
  private timerPoda?: NodeJS.Timeout;

  constructor() {
    super();
    // `unref` para o timer não segurar o processo no encerramento.
    this.timerPoda = setInterval(() => {
      this.podar().catch((err) => logger.error({ err }, "falha ao podar sessões expiradas"));
    }, PODA_INTERVALO_MS);
    this.timerPoda.unref();
  }

  /** Remove as sessões vencidas. O índice em `expiresAt` cobre este DELETE. */
  async podar(): Promise<number> {
    const { count } = await prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) logger.debug({ count }, "sessões expiradas removidas");
    return count;
  }

  get(
    sid: string,
    callback: (err?: unknown, session?: SessionData | null) => void,
  ): void {
    prisma.session
      .findUnique({ where: { sid } })
      .then((row) => {
        if (!row) return callback(null, null);

        // Expirada: trata como inexistente e limpa a linha de passagem.
        if (row.expiresAt.getTime() <= Date.now()) {
          return prisma.session
            .deleteMany({ where: { sid } })
            .then(() => callback(null, null))
            .catch((err) => callback(err));
        }

        try {
          callback(null, JSON.parse(row.data) as SessionData);
        } catch (err) {
          // Dado corrompido não deve derrubar a requisição — força um login novo.
          logger.warn({ err, sid }, "sessão com JSON inválido — descartada");
          callback(null, null);
        }
      })
      .catch((err) => callback(err));
  }

  set(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    const data = JSON.stringify(sess);
    const expiresAt = expiraEm(sess);

    prisma.session
      .upsert({
        where: { sid },
        create: { sid, data, expiresAt },
        update: { data, expiresAt },
      })
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    // `deleteMany` em vez de `delete` para não lançar quando a linha já não existe
    // (logout duplo, sessão já podada).
    prisma.session
      .deleteMany({ where: { sid } })
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  /**
   * Renova só a validade. Com `resave: false`, é o que o express-session chama a
   * cada requisição de uma sessão que não mudou — daí não reescrever `data`.
   */
  touch(sid: string, sess: SessionData, callback?: () => void): void {
    prisma.session
      .updateMany({ where: { sid }, data: { expiresAt: expiraEm(sess) } })
      .then(() => callback?.())
      .catch((err) => {
        logger.warn({ err, sid }, "falha ao renovar validade da sessão");
        callback?.();
      });
  }
}
