import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { logger } from "../shared/logger.js";

/**
 * Regra de negócio violada DENTRO de uma transação.
 *
 * Existe para poder abortar com rollback. As checagens de conflito faziam
 * `return { erro }`, e uma transação interativa do Prisma que retorna normalmente
 * é COMMITADA — o que era inofensivo enquanto nenhuma escrita vinha antes da
 * checagem, mas deixa lixo no banco assim que vem (agendamento criado e slot não
 * reservado, por exemplo). Lançar garante que nada parcial sobrevive.
 */
export class ConflitoAgendamento extends Error {
  constructor(public readonly motivo: string) {
    super(motivo);
    this.name = "ConflitoAgendamento";
  }
}

/** Número máximo de tentativas antes de desistir de uma transação serializável. */
const TENTATIVAS_MAX = 4;

/**
 * Postgres aborta uma das transações concorrentes com SQLSTATE 40001; o Prisma
 * traduz para P2034. É uma falha esperada em SERIALIZABLE, não um bug — a
 * resposta certa é tentar de novo.
 */
function ehConflitoDeSerializacao(err: unknown): boolean {
  // P2002 (violação de índice único) NÃO entra aqui de propósito: é constraint
  // violada, não conflito de escalonamento, e repetir só falharia de novo.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === "P2034";
  }
  // Alguns caminhos chegam como erro cru do driver.
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("40001") || msg.includes("could not serialize");
}

function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Roda uma transação em nível SERIALIZABLE, repetindo em caso de conflito.
 *
 * O nível padrão do Postgres é READ COMMITTED, em que um `findFirst` não tranca
 * linha nenhuma: duas transações simultâneas liam "não há conflito" e as duas
 * gravavam. Não bastava um índice único para fechar isso, porque o overbooking
 * acontece entre LINHAS DE SLOT DIFERENTES do mesmo profissional no mesmo
 * horário — e slots duplicados existem por desenho, já que cancelar cria um slot
 * novo em vez de reabrir o antigo.
 *
 * Em SERIALIZABLE o Postgres detecta a dependência entre as duas e aborta uma,
 * que então é repetida aqui e agora enxerga o agendamento da outra.
 *
 * Retorna `{ erro }` quando a regra de negócio barra (via ConflitoAgendamento),
 * para o chamador seguir o mesmo formato de antes.
 */
export async function transacaoSerializavel<T>(
  rotulo: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | { erro: string }> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_MAX; tentativa++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      if (err instanceof ConflitoAgendamento) return { erro: err.motivo };

      if (ehConflitoDeSerializacao(err) && tentativa < TENTATIVAS_MAX) {
        // Espera crescente com um pouco de aleatoriedade, para duas transações
        // que colidiram não voltarem juntas e colidirem de novo.
        await esperar(tentativa * 20 + Math.random() * 20);
        continue;
      }

      if (ehConflitoDeSerializacao(err)) {
        logger.warn(
          { rotulo, tentativas: tentativa },
          "transação desistiu após conflitos de serialização",
        );
        return { erro: "Esse horário acabou de ser reservado. Escolha outro." };
      }

      throw err;
    }
  }

  // Inalcançável: o laço só sai por return ou throw.
  return { erro: "Não foi possível concluir a operação. Tente novamente." };
}
