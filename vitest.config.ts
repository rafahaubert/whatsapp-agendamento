import { defineConfig } from "vitest/config";

// Testes de unidade — puros, sem banco. Rodam com `npm test`.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    // Roda ANTES dos arquivos de teste: sem as variáveis obrigatórias,
    // src/config/env.ts derruba o processo já na coleta. Ver test/setupEnv.ts.
    setupFiles: ["test/setupEnv.ts"],
  },
});
