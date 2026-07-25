import type { ResolvedTenant } from "../db/tenantRepository.js";

/**
 * Formato interno, agnóstico de canal. Cada adaptador (WhatsApp hoje;
 * Telegram/Instagram amanhã) converte suas mensagens para `IncomingMessage`.
 * Assim o motor de conversa (`core/`) nunca conhece detalhes da Meta.
 */
export type ChannelType = "whatsapp";

export interface IncomingMessage {
  channel: ChannelType;
  tenant: ResolvedTenant;
  from: string; // telefone do paciente (E.164)
  messageId: string;
  timestamp: Date;
  text: string; // Fase 1: apenas texto
}

/**
 * Contrato que o motor de conversa implementará (Fase 2). Recebe a mensagem
 * já resolvida e devolve o texto de resposta (ou null para não responder).
 */
export interface MessageHandler {
  handle(message: IncomingMessage): Promise<string | null>;
}
