/**
 * Contexto da execução em curso — o que amarra as linhas de log de UMA mensagem.
 *
 * O problema que isto resolve: uma mensagem do paciente atravessa webhook →
 * caixa de entrada → motor → ferramentas → domínio, e cada camada logava o que
 * achava relevante. Quando algo dava errado, juntar as peças era garimpar por
 * timestamp e torcer para nenhuma outra conversa estar acontecendo junto. Num
 * sistema que atende várias clínicas ao mesmo tempo, isso não fecha.
 *
 * Usa `AsyncLocalStorage` de propósito, e não um parâmetro atravessando todas as
 * assinaturas: o contexto acompanha a execução assíncrona sozinho, sem que
 * `scheduling.ts` precise conhecer a existência de um id de correlação para
 * poder registrá-lo.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface ContextoExecucao {
  /** Amarra todas as linhas de log de uma mesma mensagem. */
  correlacao: string;
  /** Slug da clínica, quando já foi resolvida. */
  tenant?: string;
}

const armazenamento = new AsyncLocalStorage<ContextoExecucao>();

/** Roda `fn` dentro de um contexto novo. Tudo que ela chamar enxerga o mesmo. */
export function comContexto<T>(ctx: Omit<ContextoExecucao, "correlacao"> & { correlacao?: string }, fn: () => T): T {
  return armazenamento.run({ ...ctx, correlacao: ctx.correlacao ?? randomUUID().slice(0, 8) }, fn);
}

/** O contexto em vigor, ou `undefined` fora de uma execução rastreada. */
export function contextoAtual(): ContextoExecucao | undefined {
  return armazenamento.getStore();
}
