/**
 * Transcrição de áudio (Groq Whisper).
 *
 * Paciente brasileiro manda áudio no WhatsApp; sem isso o bot ficaria mudo.
 * Segue o mesmo padrão opcional da integração do Google: sem `GROQ_API_KEY`
 * configurada, as funções viram no-op e o motor pede que o paciente escreva.
 */
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELO = "whisper-large-v3-turbo";

export function isTranscricaoConfigurada(): boolean {
  return Boolean(env.GROQ_API_KEY);
}

/** Transcreve o áudio em pt-BR. Retorna null se desligado ou se falhar. */
export async function transcreverAudio(
  audio: Buffer,
  mimeType = "audio/ogg",
): Promise<string | null> {
  if (!env.GROQ_API_KEY) return null;

  try {
    const extensao = mimeType.includes("mp4") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : "ogg";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${extensao}`);
    form.append("model", MODELO);
    form.append("language", "pt");
    form.append("response_format", "json");

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      logger.error({ status: res.status, body: await res.text() }, "falha na transcrição de áudio");
      return null;
    }

    const json = (await res.json()) as { text?: string };
    const texto = json.text?.trim();
    return texto || null;
  } catch (err) {
    logger.error({ err }, "erro ao transcrever áudio");
    return null;
  }
}
