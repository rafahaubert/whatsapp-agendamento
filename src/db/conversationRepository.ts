import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./client.js";

/** Dados estruturados que sobrevivem entre mensagens (além do histórico). */
export interface ConversationState {
  patientId?: string;
}

/** Carrega o histórico (mensagens para o Claude) e o estado por telefone. */
export async function loadConversation(
  tenantId: string,
  phone: string,
): Promise<{ history: Anthropic.MessageParam[]; state: ConversationState }> {
  const conv = await prisma.conversation.findUnique({
    where: { tenantId_patientPhone: { tenantId, patientPhone: phone } },
  });
  if (!conv) return { history: [], state: {} };

  const history = conv.history ? (JSON.parse(conv.history) as Anthropic.MessageParam[]) : [];
  const state = conv.state ? (JSON.parse(conv.state) as ConversationState) : {};
  return { history, state };
}

/** Persiste (upsert) o histórico e o estado. `state`/`history` são JSON (String no banco). */
export async function saveConversation(
  tenantId: string,
  phone: string,
  history: Anthropic.MessageParam[],
  state: ConversationState,
): Promise<void> {
  const historyStr = JSON.stringify(history);
  const stateStr = JSON.stringify(state);

  await prisma.conversation.upsert({
    where: { tenantId_patientPhone: { tenantId, patientPhone: phone } },
    create: {
      tenantId,
      patientPhone: phone,
      state: stateStr,
      history: historyStr,
      lastMessageAt: new Date(),
    },
    update: { state: stateStr, history: historyStr, lastMessageAt: new Date() },
  });
}
