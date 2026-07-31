import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Configuração enxuta de propósito.
 *
 * O código já existe e funciona. O preset `recommendedTypeChecked` completo
 * produz ~280 avisos aqui, quase todos `no-unsafe-*` vindos dos `any`
 * deliberados nos payloads da Meta e nos corpos de formulário — sinal nenhum,
 * ruído demais, e ninguém lê a segunda página.
 *
 * A base é a `recommended` (sem tipos) e, por cima, apenas as regras COM tipo
 * que pegam as classes de bug que importam num sistema cheio de `async`:
 * promessa criada e não aguardada, `async` passado onde se espera retorno
 * síncrono, `await` faltando. Formatação fica toda com o Prettier.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "prisma/migrations/**",
      "eslint.config.js",
      "*.config.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // `any` é usado de propósito em alguns pontos (payloads da Meta,
      // formulários do painel), sempre com comentário. Avisa, não quebra.
      "@typescript-eslint/no-explicit-any": "warn",
      // Argumento não usado prefixado com _ é intencional (`_req`, `_res`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Regras que precisam do type-checker. Só valem para `src/`, que é o que o
  // tsconfig cobre.
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // O bug mais provável neste código: uma gravação no banco que ninguém
      // espera, e o processo segue (ou sai) antes de ela terminar.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/await-thenable": "error",
      // Concatenar objeto em string vira "[object Object]" silenciosamente.
      "@typescript-eslint/no-base-to-string": "error",
    },
  },
);
