import "dotenv/config";
import { z } from "zod";

/**
 * Segredo de sessão usado apenas fora de produção, para não exigir configuração
 * em `npm run dev`. Em produção este valor é REJEITADO no boot (ver `.superRefine`
 * abaixo): ele é público — está neste repositório — e quem o conhece consegue
 * forjar um cookie de sessão e entrar no painel como SUPER.
 */
const SESSION_SECRET_DEV = "troque-este-segredo-em-producao";

/**
 * Variáveis de ambiente validadas no boot. Se algo obrigatório faltar,
 * o processo encerra com uma mensagem clara em vez de falhar mais adiante.
 */
const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),

  // Fase 2
  ANTHROPIC_API_KEY: z.string().optional(),

  // WhatsApp Cloud API (Meta)
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),

  // Painel de administração
  ADMIN_USER: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(1).default(SESSION_SECRET_DEV),

  // Google Calendar (opcional) — chave JSON da conta de serviço.
  // Se ausente, a sincronização com o Google fica desligada.
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),

  // Transcrição de áudio (opcional) — Groq Whisper.
  // Se ausente, o bot pede que o paciente escreva em vez de ignorar o áudio.
  GROQ_API_KEY: z.string().optional(),

  // Token para disparar jobs (lembretes) por cron externo.
  JOBS_TOKEN: z.string().optional(),
});

/**
 * Regras que dependem de mais de um campo. Em produção o segredo de sessão tem
 * de ser real: antes havia apenas um aviso no startup, e ele nunca disparava
 * porque comparava com uma string diferente do default — um deploy sem
 * SESSION_SECRET subia silenciosamente assinando sessões com segredo público.
 * Agora o boot falha, do mesmo jeito que falha sem DATABASE_URL.
 */
const schemaValidado = schema.superRefine((valores, ctx) => {
  if (valores.NODE_ENV !== "production") return;

  if (valores.SESSION_SECRET === SESSION_SECRET_DEV) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SESSION_SECRET"],
      message:
        "em produção é obrigatório definir um segredo próprio " +
        "(ex.: SESSION_SECRET=$(openssl rand -hex 32)) — o valor padrão é público",
    });
  }
});

const parsed = schemaValidado.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "❌ Variáveis de ambiente inválidas:",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;
