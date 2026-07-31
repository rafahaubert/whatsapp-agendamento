import { prisma } from "./client.js";
import { logger } from "../shared/logger.js";

/**
 * Marca uma mensagem como processada. Retorna `true` se foi a PRIMEIRA vez
 * (deve processar) e `false` se já havia sido processada (reentrega da Meta →
 * ignorar). A unicidade da PK garante atomicidade mesmo com entregas simultâneas.
 */
export async function markMessageProcessed(messageId: string): Promise<boolean> {
  try {
    await prisma.processedMessage.create({ data: { id: messageId } });
    return true;
  } catch {
    return false; // já existe → duplicata
  }
}

/**
 * Desfaz a marca quando o processamento falhou.
 *
 * A marca é gravada ANTES de processar, porque é ela que serializa as
 * reentregas simultâneas da Meta. O efeito colateral é que um erro no meio do
 * caminho deixava a mensagem marcada para sempre: nunca respondida e nunca
 * reprocessável. Liberando o registro, uma reentrega da Meta (ou um replay
 * manual) volta a ser aceita.
 */
export async function unmarkMessageProcessed(messageId: string): Promise<void> {
  try {
    await prisma.processedMessage.deleteMany({ where: { id: messageId } });
  } catch (err) {
    // Não pode derrubar o tratamento do erro original que trouxe a gente aqui.
    logger.warn({ err, messageId }, "falha ao liberar a marca de idempotência");
  }
}

/**
 * Remove marcas antigas. A tabela só cresce — sem poda, ela acumula uma linha
 * por mensagem recebida para sempre.
 *
 * 30 dias é folgado: a Meta reentrega em minutos, não em semanas. O índice em
 * `createdAt` cobre este DELETE.
 */
export async function podarMensagensProcessadas(diasRetencao = 30): Promise<number> {
  const limite = new Date(Date.now() - diasRetencao * 24 * 60 * 60 * 1000);
  const { count } = await prisma.processedMessage.deleteMany({
    where: { createdAt: { lt: limite } },
  });
  if (count > 0) logger.info({ count, diasRetencao }, "marcas de idempotência antigas removidas");
  return count;
}
