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
  /** Texto digitado ou rótulo da opção escolhida. Null em áudio/mídia. */
  text: string | null;
  /** ID da mídia de áudio, quando o paciente mandou um áudio. */
  audioId?: string;
  /** Payload da opção escolhida (ex.: "SLOT:abc", "CONFIRMAR:xyz"). */
  payload?: string;
  /** Tipo bruto recebido no canal (text, audio, image…). */
  tipo?: string;
}

/** Opção apresentada ao paciente (vira lista/botões no WhatsApp). */
export interface ReplyOption {
  id: string;
  titulo: string;
  descricao?: string;
}

/** Resposta do motor: texto e, opcionalmente, opções para o paciente escolher. */
export interface Reply {
  texto: string;
  opcoes?: ReplyOption[];
  /** Rótulo do botão que abre a lista (quando há opções). */
  rotuloOpcoes?: string;
}

/**
 * Contrato do motor de conversa. Recebe a mensagem já resolvida e devolve a
 * resposta (ou null para não responder — ex.: conversa em atendimento humano).
 */
export interface MessageHandler {
  handle(message: IncomingMessage): Promise<Reply | null>;
}
