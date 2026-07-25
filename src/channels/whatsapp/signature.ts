import crypto from "node:crypto";

/**
 * Valida a assinatura `X-Hub-Signature-256` enviada pela Meta.
 * Garante que o webhook veio mesmo do WhatsApp (e não foi adulterado).
 * Requer o corpo CRU da requisição (bytes exatos), por isso capturamos
 * `rawBody` no server.ts.
 */
export function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: Buffer,
  signatureHeader?: string,
): boolean {
  if (!signatureHeader) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const received = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);

  // Comparação em tempo constante evita timing attacks.
  if (received.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(received, expectedBuf);
}
