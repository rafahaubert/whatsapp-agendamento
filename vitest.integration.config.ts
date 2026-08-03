import { defineConfig } from "vitest/config";

// Testes de integração — usam um PostgreSQL de teste apontado por TEST_DATABASE_URL.
// Rodam com `npm run test:integration`. O globalSetup (test/integration/setup.ts) cria
// o schema num banco isolado antes de tudo; sem a variável, os testes são pulados.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/integration/setup.ts"],
    // Mesmo motivo dos testes de unidade: sem as variáveis obrigatórias,
    // src/config/env.ts derruba o processo na COLETA e nenhum teste roda. Só
    // o banco vem de fora (TEST_DATABASE_URL). Ver test/setupEnv.ts.
    setupFiles: ["test/setupEnv.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
