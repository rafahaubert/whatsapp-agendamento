/**
 * Ambiente mínimo para os testes — de unidade e de integração.
 *
 * `src/config/env.ts` valida as variáveis obrigatórias no import e chama
 * `process.exit(1)` quando falta alguma. Como quase todo módulo do projeto o
 * importa transitivamente, quem clonasse o repositório e rodasse `npm test` sem
 * um `.env` local via metade dos arquivos de teste falhar na COLETA — antes de
 * executar um único caso. O sintoma ("process.exit unexpectedly called with 1")
 * não diz nada sobre a causa, e como não havia CI ninguém percebia.
 *
 * Os valores abaixo são fictícios de propósito: os testes de unidade são puros
 * (sem banco, sem rede). Um `.env` de verdade, se existir, continua mandando —
 * daí o `??=`.
 *
 * A exceção é o banco: os testes de integração usam um Postgres real, e quem
 * manda é o `TEST_DATABASE_URL`. Derivar o `DATABASE_URL` dele aqui evita
 * depender da ordem em que o globalSetup e este arquivo rodam.
 */
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? "postgresql://teste:teste@localhost:5432/teste?schema=public";
process.env.WHATSAPP_VERIFY_TOKEN ??= "token-de-teste";
process.env.WHATSAPP_APP_SECRET ??= "segredo-de-teste";
process.env.WHATSAPP_ACCESS_TOKEN ??= "acesso-de-teste";
process.env.ADMIN_USER ??= "admin";
process.env.ADMIN_PASSWORD ??= "senha-de-teste";
process.env.SESSION_SECRET ??= "segredo-de-sessao-de-teste-suficientemente-longo";
