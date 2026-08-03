import Anthropic from "@anthropic-ai/sdk";

/**
 * Cliente único da Anthropic. A chave vem de ANTHROPIC_API_KEY (o SDK lê do
 * ambiente automaticamente; o dotenv já a carregou em src/config/env.ts).
 *
 * O timeout é o ponto importante. O padrão do SDK é DEZ MINUTOS, e como
 * src/core/inbox.ts serializa uma execução por conversa, uma chamada pendurada
 * trava aquela conversa por todo esse tempo: o paciente escreve, escreve de
 * novo e não recebe nada. Sessenta segundos é folgado para a resposta de um
 * agendamento e curto o bastante para o paciente não desistir.
 *
 * As tentativas são do próprio SDK (429, 408, 409, 5xx e falhas de conexão,
 * com backoff, respeitando `retry-after`); erros de requisição (4xx) não são
 * repetidos, que é o comportamento correto — repetir um 400 só gasta.
 */
export const anthropic = new Anthropic({
  timeout: 60_000, // ms
  maxRetries: 2,
});
