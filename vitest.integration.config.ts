import { defineConfig } from "vitest/config";

// Testes de integração — usam um SQLite temporário. Rodam com `npm run test:integration`.
// O globalSetup cria o schema num banco de teste isolado antes de tudo.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/integration/setup.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
