import express, { type Request, type Response, type Router } from "express";
import { env } from "../../config/env.js";
import { verifyWhatsAppSignature } from "./signature.js";
import { parseWhatsAppWebhook } from "./parse.js";
import { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList } from "./client.js";
import { findTenantByPhoneNumberId } from "../../db/tenantRepository.js";
import { markMessageProcessed } from "../../db/idempotency.js";
import { logger } from "../../shared/logger.js";
import type { MessageHandler } from "../types.js";
import type { WhatsAppWebhookBody } from "./types.js";

/**
 * Router do canal WhatsApp. Recebe o `MessageHandler` por injeção — na Fase 1
 * é um placeholder (saudação); na Fase 2 será o motor de conversa.
 */
export function makeWhatsAppRouter(handler: MessageHandler): Router {
  const router = express.Router();

  // 1) Verificação do webhook — a Meta chama uma vez, ao configurar.
  router.get("/", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(String(challenge));
      return;
    }
    res.sendStatus(403);
  });

  // 2) Recebimento de mensagens.
  router.post("/", async (req: Request, res: Response) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.header("x-hub-signature-256");

    if (
      !rawBody ||
      !verifyWhatsAppSignature(env.WHATSAPP_APP_SECRET, rawBody, signature)
    ) {
      res.sendStatus(401);
      return;
    }

    // A Meta exige um ACK rápido (poucos segundos). Respondemos já e
    // processamos em seguida, sem bloquear a resposta.
    res.sendStatus(200);

    try {
      const messages = parseWhatsAppWebhook(req.body as WhatsAppWebhookBody);

      for (const parsed of messages) {
        // Áudio e opções também são tratados; ignoramos apenas o que não tem conteúdo algum.
        if (!parsed.text && !parsed.audioId && !parsed.payload && parsed.tipo === "text") continue;

        // Idempotência: a Meta reentrega webhooks (ex.: durante cold start).
        // Processa cada mensagem uma única vez.
        if (!(await markMessageProcessed(parsed.messageId))) {
          logger.info({ messageId: parsed.messageId }, "mensagem duplicada — ignorada");
          continue;
        }

        // Roteamento multi-tenant: número que recebeu → clínica.
        const tenant = await findTenantByPhoneNumberId(parsed.phoneNumberId);
        if (!tenant) {
          logger.warn(
            { phoneNumberId: parsed.phoneNumberId },
            "phone_number_id sem tenant cadastrado",
          );
          continue;
        }

        const reply = await handler.handle({
          channel: "whatsapp",
          tenant,
          from: parsed.from,
          messageId: parsed.messageId,
          timestamp: parsed.timestamp,
          text: parsed.text,
          audioId: parsed.audioId,
          payload: parsed.payload,
          tipo: parsed.tipo,
        });

        if (!reply) continue;

        const numero = tenant.whatsappPhoneNumberId;
        try {
          if (reply.opcoes?.length) {
            // Até 3 opções cabem em botões; acima disso, lista interativa.
            if (reply.opcoes.length <= 3) {
              await sendWhatsAppButtons(numero, parsed.from, reply.texto, reply.opcoes);
            } else {
              await sendWhatsAppList(
                numero,
                parsed.from,
                reply.texto,
                reply.opcoes,
                reply.rotuloOpcoes,
              );
            }
          } else {
            await sendWhatsAppText(numero, parsed.from, reply.texto);
          }
        } catch (err) {
          // Nunca deixar o paciente sem resposta: se o formato interativo falhar,
          // manda o mesmo conteúdo como texto simples.
          logger.error({ err, to: parsed.from }, "falha ao enviar resposta — tentando texto");
          const lista = (reply.opcoes ?? [])
            .map((o, i) => `${i + 1}. ${o.titulo}${o.descricao ? ` — ${o.descricao}` : ""}`)
            .join("\n");
          await sendWhatsAppText(
            numero,
            parsed.from,
            lista ? `${reply.texto}\n\n${lista}` : reply.texto,
          ).catch((e) => logger.error({ err: e }, "falha também no envio de texto"));
        }
      }
    } catch (err) {
      logger.error({ err }, "erro ao processar webhook do WhatsApp");
    }
  });

  return router;
}
