import { execSync } from "node:child_process";

/**
 * globalSetup do Vitest para os testes de integração (PostgreSQL).
 *
 * Requer um Postgres de TESTE apontado por TEST_DATABASE_URL — use um banco/schema
 * SEPARADO do de desenvolvimento (o setup faz --force-reset). Ex.:
 *   TEST_DATABASE_URL="postgresql://whatsapp:whatsapp@localhost:5432/whatsapp_test?schema=public"
 *
 * Se TEST_DATABASE_URL não estiver definido, os testes de integração são pulados.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn("[integração] TEST_DATABASE_URL não definido — testes de integração pulados.");
    return;
  }

  process.env.DATABASE_URL = url;
  execSync("npx prisma db push --skip-generate --force-reset --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
