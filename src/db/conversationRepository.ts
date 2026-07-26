import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./client.js";

/** Dados estruturados que sobrevivem entre mensagens (além do histórico). */
export interface ConversationState {
  patientId?: string;
}

export interface ConversationSnapshot {
  history: Anthropic.MessageParam[];
  state: ConversationState;
  /** true = conversa em atendimento humano; o bot fica em silêncio. */
  humanHandoff: boolean;
}

/** Carrega o histórico (mensagens para o Claude) e o estado por telefone. */
export async function loadConversation(
  tenantId: string,
  phone: string,
): Promise<ConversationSnapshot> {
  const conv = await prisma.conversation.findUnique({
    where: { tenantId_patientPhone: { tenantId, patientPhone: phone } },
  });
  if (!conv) return { history: [], state: {}, humanHandoff: false };

  const history = conv.history ? (JSON.parse(conv.history) as Anthropic.MessageParam[]) : [];
  const state = conv.state ? (JSON.parse(conv.state) as ConversationState) : {};
  return { history, state, humanHandoff: conv.humanHandoff };
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

/** Liga/desliga o atendimento humano para uma conversa. */
export async function setHandoff(
  tenantId: string,
  phone: string,
  ativo: boolean,
): Promise<void> {
  await prisma.conversation.upsert({
    where: { tenantId_patientPhone: { tenantId, patientPhone: phone } },
    create: {
      tenantId,
      patientPhone: phone,
      state: "{}",
      humanHandoff: ativo,
      handoffAt: ativo ? new Date() : null,
      lastMessageAt: new Date(),
    },
    update: { humanHandoff: ativo, handoffAt: ativo ? new Date() : null },
  });
}

/** Registra a mensagem no log legível da caixa de entrada. */
export async function logMessage(
  tenantId: string,
  phone: string,
  direction: "IN" | "OUT",
  text: string,
  sentBy: "BOT" | "HUMAN" | "PATIENT",
  tokens?: { input: number; output: number },
): Promise<void> {
  await prisma.message.create({
    data: {
      tenantId,
      phone,
      direction,
      text,
      sentBy,
      inputTokens: tokens?.input ?? null,
      outputTokens: tokens?.output ?? null,
    },
  });
}
