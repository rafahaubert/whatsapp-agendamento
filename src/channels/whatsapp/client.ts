import { env } from "../../config/env.js";

/**
 * Envia uma mensagem de texto pela Cloud API.
 * O `phoneNumberId` vem do tenant, então a MESMA credencial global pode enviar
 * a partir de números diferentes (multi-clínica). Se no futuro cada clínica
 * tiver seu próprio token, basta receber o token por parâmetro aqui.
 */
export async function sendWhatsAppText(
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<void> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Falha ao enviar WhatsApp (${res.status}): ${body}`);
  }
}
