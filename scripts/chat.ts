/**
 * REPL de teste — conversa com o agente no terminal, sem WhatsApp nem Meta.
 * Útil para QA manual. Requer: banco populado (npm run seed) e ANTHROPIC_API_KEY.
 *
 * Uso: npm run chat            (usa a clínica "clinica-exemplo")
 *      npm run chat outra-slug (usa outra clínica)
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prisma } from "../src/db/client.js";
import { conversationEngine } from "../src/core/engine.js";
import type { ResolvedTenant } from "../src/db/tenantRepository.js";
import type { TenantConfig } from "../src/config/types.js";

const slug = process.argv[2] ?? "clinica-exemplo";
const phone = "+5511999990000"; // telefone simulado do paciente

async function main() {
  const t = await prisma.tenant.findUnique({ where: { slug } });
  if (!t) {
    console.error(`Tenant "${slug}" não encontrado. Rode: npm run seed`);
    process.exit(1);
  }

  const tenant: ResolvedTenant = {
    id: t.id,
    slug: t.slug,
    name: t.name,
    timezone: t.timezone,
    whatsappPhoneNumberId: t.whatsappPhoneNumberId,
    config: JSON.parse(t.config) as TenantConfig,
  };

  console.log(`\n💬 Conversando com "${tenant.name}" (paciente simulado ${phone}).`);
  console.log("   Digite sua mensagem. Ctrl+C para sair.\n");

  const rl = createInterface({ input: stdin, output: stdout });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const text = (await rl.question("você: ")).trim();
    if (!text) continue;

    const reply = await conversationEngine.handle({
      channel: "whatsapp",
      tenant,
      from: phone,
      messageId: randomUUID(),
      timestamp: new Date(),
      text,
    });

    console.log(`\nagente: ${reply}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
