import type { WhatsAppWebhookBody } from "./types.js";

/** Mensagem extraída do payload da Meta, ainda sem o tenant resolvido. */
export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  from: string;
  messageId: string;
  timestamp: Date;
  text: string | null; // null quando o tipo não é texto (ignorado na Fase 1)
}

/**
 * Achata o payload aninhado da Meta (entry[].changes[].value.messages[])
 * numa lista simples. Recibos de status (statuses[]) são ignorados.
 */
export function parseWhatsAppWebhook(
  body: WhatsAppWebhookBody,
): ParsedWhatsAppMessage[] {
  const result: ParsedWhatsAppMessage[] = [];
  if (!body?.entry) return result;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId || !value.messages) continue;

      for (const msg of value.messages) {
        result.push({
          phoneNumberId,
          from: msg.from,
          messageId: msg.id,
          timestamp: new Date(Number(msg.timestamp) * 1000),
          text: msg.type === "text" ? (msg.text?.body ?? null) : null,
        });
      }
    }
  }

  return result;
}
