import { defineConfig } from "vitest/config";

// Testes de unidade — puros, sem banco. Rodam com `npm test`.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
