import path from "node:path";
import express from "express";
import session from "express-session";
import { env } from "./config/env.js";
import { makeWhatsAppRouter } from "./channels/whatsapp/webhook.js";
import { conversationEngine } from "./core/engine.js";
import { makeAdminRouter } from "./admin/router.js";
import { PrismaSessionStore } from "./admin/sessionStore.js";
import { carregarProposta } from "./marketing/proposta.js";
import { enviarLembretes } from "./jobs/reminders.js";
import { renovarAgendas } from "./jobs/agenda.js";
import { enviarReativacoes } from "./jobs/recall.js";
import { logger } from "./shared/logger.js";
import { safeEqual } from "./shared/comparacao.js";
import { limiteJobs } from "./shared/rateLimit.js";
import { prisma } from "./db/client.js";
import { drenarCaixaDeEntrada, pendenciasAbertas } from "./core/inbox.js";
import { podarMensagensProcessadas } from "./db/idempotency.js";

const app = express();

// Views do painel (EJS). Os templates ficam em ./views (fora de src, presentes
// em dev e em produção).
app.set("view engine", "ejs");
app.set("views", path.resolve(process.cwd(), "views"));

// Estáticos do painel (logos da marca, favicon). São imutáveis na prática —
// vale um cache longo para não repetir download a cada navegação.
app.use(
  express.static(path.resolve(process.cwd(), "public"), {
    maxAge: "7d",
    index: false,
  }),
);

// Headers de segurança básicos.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Webhook: precisa do corpo CRU (Buffer) para validar a assinatura HMAC.
// Limita a 100kb para evitar payload bombing.
app.use(
  "/webhook/whatsapp",
  express.json({
    limit: "100kb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

// Formulários do painel.
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Requisições JSON do painel (o arrastar/soltar do calendário). Vem DEPOIS do
// parser específico do webhook, que precisa capturar o corpo cru para o HMAC.
// Sem isto, `req.body` chegava vazio em POST /clinicas/:id/agendamentos/:id/mover
// e o arrastar/soltar respondia 400 sempre.
app.use(express.json({ limit: "1mb" }));

// Atrás do proxy do provedor (Render/Fly): necessário para o cookie `secure`
// e para o IP real do cliente.
const emProducao = env.NODE_ENV === "production";
if (emProducao) app.set("trust proxy", 1);

// Sessão do painel de administração. O store fica no Postgres: com o MemoryStore
// padrão, todo deploy derrubava a sessão de todos os operadores.
app.use(
  session({
    store: new PrismaSessionStore(),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "haubert.sid", // não usa o nome padrão connect.sid
    rolling: true, // renova a validade a cada requisição (o store implementa touch)
    cookie: {
      httpOnly: true, // fora do alcance de JavaScript
      sameSite: "lax", // primeira barreira de CSRF; o token em admin/csrf.ts é a segunda
      secure: emProducao, // só trafega por HTTPS em produção
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);

/**
 * Healthcheck usado por Render (`healthCheckPath`) e Fly (`http_service.checks`).
 *
 * Consulta o banco de propósito: antes devolvia 200 estático, então uma instância
 * com o Postgres inacessível continuava sendo considerada saudável e recebendo
 * tráfego — o webhook aceitava mensagens que não conseguia gravar. Sem banco,
 * este serviço não faz nada de útil, então "sem banco" é "não saudável".
 *
 * O timeout é menor que o do provedor (2s no fly.toml) para responder 503 em vez
 * de estourar o prazo do check.
 */
const HEALTH_TIMEOUT_MS = 1200;

app.get("/health", async (_req, res) => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_ok, reject) =>
        setTimeout(() => reject(new Error("timeout na consulta ao banco")), HEALTH_TIMEOUT_MS),
      ),
    ]);
    res.json({ ok: true, service: "whatsapp-clinic-agent", db: "up" });
  } catch (err) {
    logger.error({ err }, "healthcheck falhou — banco inacessível");
    res.status(503).json({ ok: false, service: "whatsapp-clinic-agent", db: "down" });
  }
});

// Raiz → painel.
app.get("/", (_req, res) => res.redirect("/admin"));

// Política de privacidade (URL exigida para publicar o app na Meta).
app.get("/privacidade", (_req, res) => res.render("privacidade"));

// Proposta comercial, para mandar a potenciais clientes.
app.get("/proposta", async (_req, res) => {
  try {
    res.type("html").send(await carregarProposta());
  } catch (err) {
    logger.error({ err }, "falha ao servir a proposta");
    res.sendStatus(404);
  }
});

// Canal WhatsApp → motor de conversa (Claude + ferramentas).
app.use("/webhook/whatsapp", makeWhatsAppRouter(conversationEngine));

// Painel de administração.
app.use("/admin", makeAdminRouter());

/**
 * Disparo dos lembretes por cron EXTERNO (cron-job.org, UptimeRobot…).
 * Protegido por JOBS_TOKEN — útil porque o plano free hiberna e o setInterval
 * abaixo pode não rodar no horário.
 */
app.post(["/jobs/run", "/jobs/reminders"], limiteJobs, async (req, res) => {
  // Só pelo header: aceitar `?token=` colocava o segredo na URL, que vai para o
  // access log do provedor, para o histórico do navegador e para o Referer.
  const token = req.header("x-jobs-token");
  if (!env.JOBS_TOKEN || !token || !safeEqual(token, env.JOBS_TOKEN)) {
    logger.warn({ ip: req.ip, path: req.path }, "tentativa de acesso não autorizado aos jobs");
    return res.sendStatus(401);
  }
  try {
    // Lembretes sempre; a agenda só na rota unificada (mantém /jobs/reminders leve
    // para quem já configurou o cron antigo).
    const lembretes = await enviarLembretes();
    const agenda = req.path === "/jobs/run" ? await renovarAgendas() : null;
    const reativacoes = req.path === "/jobs/run" ? await enviarReativacoes() : null;
    res.json({ ok: true, lembretes, agenda, reativacoes });
  } catch (err) {
    logger.error({ err }, "falha ao executar os jobs");
    res.status(500).json({ ok: false });
  }
});

// Verificação de configurações críticas no startup.
// SESSION_SECRET não entra aqui: em produção o boot falha em config/env.ts se não
// for definido, o que é mais forte que um aviso (e o aviso antigo comparava com
// uma string que nunca era o default, então nunca disparava).
if (emProducao && !env.JOBS_TOKEN) {
  logger.warn(
    "JOBS_TOKEN não configurado — /jobs/run e /jobs/reminders responderão 401 a TODAS " +
      "as chamadas. Defina a variável para habilitar o cron externo.",
  );
}

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, painel: "/admin", webhook: "/webhook/whatsapp", proposta: "/proposta" },
    "servidor no ar",
  );

  // Verificação periódica dos lembretes (a cada 10 min) enquanto o processo vive.
  setInterval(
    () => {
      enviarLembretes().catch((err) => logger.error({ err }, "falha no ciclo de lembretes"));
    },
    10 * 60 * 1000,
  ).unref();

  // Agenda rolante: uma vez por dia (e uma vez ao subir, após 1 min).
  setTimeout(() => {
    renovarAgendas().catch((err) => logger.error({ err }, "falha ao renovar agendas"));
  }, 60 * 1000).unref();

  setInterval(
    () => {
      renovarAgendas().catch((err) => logger.error({ err }, "falha ao renovar agendas"));
      enviarReativacoes().catch((err) => logger.error({ err }, "falha nas reativações"));
      podarMensagensProcessadas().catch((err) =>
        logger.error({ err }, "falha ao podar marcas de idempotência"),
      );
    },
    24 * 60 * 60 * 1000,
  ).unref();
});

/**
 * Encerramento gracioso.
 *
 * O agrupamento de mensagens vive em memória e espera alguns segundos antes de
 * processar (ver src/core/inbox.ts). Sem isto, um deploy no meio dessa janela
 * matava o lote — e como o wamid já estava marcado como processado, a Meta não
 * reenviava e a mensagem do paciente sumia sem nenhum registro. Agora paramos de
 * aceitar conexões, processamos o que está pendente e só então saímos.
 *
 * O prazo total é menor que o `kill_timeout` do fly.toml, para o processo sair
 * por conta própria antes de levar SIGKILL.
 */
const PRAZO_ENCERRAMENTO_MS = 20_000;
let encerrando = false;

async function encerrar(sinal: string): Promise<void> {
  if (encerrando) return;
  encerrando = true;

  const pendencias = pendenciasAbertas();
  logger.info({ sinal, ...pendencias }, "encerrando — parando de aceitar conexões");

  // Para de aceitar novas conexões; as em curso terminam.
  server.close();

  // Rede de segurança: se algo travar, sai mesmo assim em vez de ficar pendurado.
  const desistir = setTimeout(() => {
    logger.warn("prazo de encerramento esgotado — saindo com lotes possivelmente pendentes");
    process.exit(1);
  }, PRAZO_ENCERRAMENTO_MS + 3_000);
  desistir.unref();

  try {
    await drenarCaixaDeEntrada(PRAZO_ENCERRAMENTO_MS);
    logger.info(pendenciasAbertas(), "caixa de entrada drenada");
  } catch (err) {
    logger.error({ err }, "falha ao drenar a caixa de entrada");
  }

  await prisma.$disconnect().catch(() => {});
  logger.info("encerrado");
  process.exit(0);
}

process.on("SIGTERM", () => void encerrar("SIGTERM"));
process.on("SIGINT", () => void encerrar("SIGINT"));
