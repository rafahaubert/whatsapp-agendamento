import { env } from "../../config/env.js";

/**
 * Baixa uma mídia da Cloud API. São dois passos:
 *   1. GET /{media-id}  → devolve a `url` temporária
 *   2. GET {url}        → o binário (exige o mesmo Bearer)
 */
export async function baixarMidia(
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const headers = { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` };

  const metaRes = await fetch(
    `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${mediaId}`,
    { headers },
  );
  if (!metaRes.ok) throw new Error(`Falha ao obter mídia (${metaRes.status})`);

  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) return null;

  const arquivo = await fetch(meta.url, { headers });
  if (!arquivo.ok) throw new Error(`Falha ao baixar mídia (${arquivo.status})`);

  return {
    buffer: Buffer.from(await arquivo.arrayBuffer()),
    mimeType: meta.mime_type ?? "audio/ogg",
  };
}
