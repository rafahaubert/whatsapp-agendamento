import { describe, it, expect } from "vitest";
import { parseWhatsAppWebhook } from "../../src/channels/whatsapp/parse.js";
import type { WhatsAppWebhookBody, WhatsAppMessage } from "../../src/channels/whatsapp/types.js";

function payload(msg: Partial<WhatsAppMessage>): WhatsAppWebhookBody {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "55", phone_number_id: "PNID" },
              messages: [
                { from: "5551999", id: "wamid.1", timestamp: "1769500000", type: "text", ...msg },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("parseWhatsAppWebhook", () => {
  it("extrai texto", () => {
    const [m] = parseWhatsAppWebhook(payload({ type: "text", text: { body: "oi" } }));
    expect(m.text).toBe("oi");
    expect(m.phoneNumberId).toBe("PNID");
    expect(m.audioId).toBeUndefined();
  });

  it("extrai áudio", () => {
    const [m] = parseWhatsAppWebhook(
      payload({ type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg" } }),
    );
    expect(m.audioId).toBe("MEDIA1");
    expect(m.text).toBeNull();
  });

  it("extrai resposta de botão de template", () => {
    const [m] = parseWhatsAppWebhook(
      payload({ type: "button", button: { payload: "CONFIRMAR:appt1", text: "Confirmar" } }),
    );
    expect(m.payload).toBe("CONFIRMAR:appt1");
    expect(m.text).toBe("Confirmar");
  });

  it("extrai escolha de lista interativa", () => {
    const [m] = parseWhatsAppWebhook(
      payload({
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "SLOT:s1", title: "seg 09:30" } },
      }),
    );
    expect(m.payload).toBe("SLOT:s1");
    expect(m.text).toBe("seg 09:30");
  });

  it("registra tipos não suportados sem quebrar", () => {
    const [m] = parseWhatsAppWebhook(payload({ type: "image" }));
    expect(m.tipo).toBe("image");
    expect(m.text).toBeNull();
  });

  it("ignora payload sem mensagens", () => {
    expect(parseWhatsAppWebhook({ object: "x" })).toEqual([]);
  });
});
