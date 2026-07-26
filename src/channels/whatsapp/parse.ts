import type { WhatsAppWebhookBody } from "./types.js";

/** Mensagem extraída do payload da Meta, ainda sem o tenant resolvido. */
export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  from: string;
  messageId: string;
  timestamp: Date;
  /** Texto digitado, título do botão/opção escolhida, ou null (ex.: áudio). */
  text: string | null;
  /** ID da mídia de áudio, quando o paciente manda um áudio. */
  audioId?: string;
  /** Payload de botão de template ou id da opção interativa (ex.: "SLOT:abc"). */
  payload?: string;
  /** Tipo bruto da mensagem, para tratar mídias não suportadas. */
  tipo: string;
}

/**
 * Achata o payload aninhado da Meta (entry[].changes[].value.messages[])
 * numa lista simples. Recibos de status (statuses[]) são ignorados.
 *
 * Cobre texto, áudio, resposta de botão de template e resposta interativa
 * (botões e lista).
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
        const base = {
          phoneNumberId,
          from: msg.from,
          messageId: msg.id,
          timestamp: new Date(Number(msg.timestamp) * 1000),
          tipo: msg.type,
        };

        switch (msg.type) {
          case "text":
            result.push({ ...base, text: msg.text?.body ?? null });
            break;

          case "audio":
            result.push({ ...base, text: null, audioId: msg.audio?.id });
            break;

          // Botão de TEMPLATE (quick reply): traz payload + rótulo.
          case "button":
            result.push({
              ...base,
              text: msg.button?.text ?? null,
              payload: msg.button?.payload ?? undefined,
            });
            break;

          // Botões/lista que NÓS enviamos: o id é o payload.
          case "interactive": {
            const escolha = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
            result.push({
              ...base,
              text: escolha?.title ?? null,
              payload: escolha?.id ?? undefined,
            });
            break;
          }

          default:
            // Mídias não suportadas (imagem, documento…): o motor responde orientando.
            result.push({ ...base, text: null });
        }
      }
    }
  }

  return result;
}
