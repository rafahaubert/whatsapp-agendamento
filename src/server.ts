import path from "node:path";
import express from "express";
import session from "express-session";
import { env } from "./config/env.js";
import { makeWhatsAppRouter } from "./channels/whatsapp/webhook.js";
import { conversationEngine } from "./core/engine.js";
import { makeAdminRouter } from "./admin/router.js";
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

// Canal WhatsApp → motor de conversa (Claude + ferramentas).
app.use("/webhook/whatsapp", makeWhatsAppRouter(conversationEngine));

// Painel de administração.
app.use("/admin", makeAdminRouter());

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, painel: "/admin", webhook: "/webhook/whatsapp" }, "servidor no ar");
});
