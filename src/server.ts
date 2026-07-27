import path from "node:path";
import express from "express";
import session from "express-session";
import { env } from "./config/env.js";
import { makeWhatsAppRouter } from "./channels/whatsapp/webhook.js";
import { conversationEngine } from "./core/engine.js";
import { makeAdminRouter } from "./admin/router.js";
import { carregarProposta } from "./marketing/proposta.js";
import { enviarLembretes } from "./jobs/reminders.js";
import { renovarAgendas } from "./jobs/agenda.js";
import { enviarReativacoes } from "./jobs/recall.js";
import { logger } from "./shared/logger.js";

const app = express();

// Views do painel (EJS). Os templates ficam em ./views (fora de src, presentes
// em dev e em produção).
app.set("view engine", "ejs");
app.set("views", path.resolve(process.cwd(), "views"));

// Webhook: precisa do corpo CRU (Buffer) para validar a assinatura HMAC.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

// Formulários do painel.
app.use(express.urlencoded({ extended: true }));

// Sessão do painel de administração.
app.use(
  session({
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "whatsapp-clinic-agent" });
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
app.post(["/jobs/run", "/jobs/reminders"], async (req, res) => {
  const token = req.header("x-jobs-token") ?? req.query.token;
  if (!env.JOBS_TOKEN || token !== env.JOBS_TOKEN) return res.sendStatus(401);
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

app.listen(env.PORT, () => {
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
    },
    24 * 60 * 60 * 1000,
  ).unref();
});
