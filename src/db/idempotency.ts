import { prisma } from "./client.js";

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
