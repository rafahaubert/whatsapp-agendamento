import Anthropic from "@anthropic-ai/sdk";

/**
 * Cliente único da Anthropic. A chave vem de ANTHROPIC_API_KEY (o SDK lê do
 * ambiente automaticamente; o dotenv já a carregou em src/config/env.ts).
 */
export const anthropic = new Anthropic();
