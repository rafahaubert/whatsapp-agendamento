import "dotenv/config";
import { z } from "zod";

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
  SESSION_SECRET: z.string().min(1).default("troque-este-segredo-em-producao"),

  // Google Calendar (opcional) — chave JSON da conta de serviço.
  // Se ausente, a sincronização com o Google fica desligada.
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "❌ Variáveis de ambiente inválidas:",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;
