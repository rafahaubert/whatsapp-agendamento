import express, {
  type Request,
  type Response,
  type Router,
  type NextFunction,
} from "express";
import { env } from "../../config/env.js";
import { verifyWhatsAppSignature } from "./signature.js";
import { parseWhatsAppWebhook } from "./parse.js";
import { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList } from "./client.js";
import { MAX_BOTOES, semOpcoesRepetidas } from "../format.js";
import { findTenantByPhoneNumberId } from "../../db/tenantRepository.js";
import { markMessageProcessed, unmarkMessageProcessed } from "../../db/idempotency.js";
import { agruparMensagem, chaveConversa } from "../../core/inbox.js";
import { logger } from "../../shared/logger.js";
import { mascararTelefone } from "../../shared/pii.js";
import { safeEqual } from "../../shared/comparacao.js";
import { texto } from "../../shared/texto.js";
import { limiteWebhook } from "../../shared/rateLimit.js";
import type { MessageHandler, Reply } from "../types.js";
import type { WhatsAppWebhookBody } from "./types.js";

/** Espera padrão antes de responder, quando a clínica não configurou uma. */
const ESPERA_PADRAO_SEGUNDOS = 8;

/**
 * Envia a resposta do motor, com degradação para texto puro se o formato
 * interativo falhar.
 *
 * Devolve `false` quando NADA chegou ao paciente (as duas tentativas falharam).
 * Antes esse caso era engolido em silêncio: a mensagem ficava marcada como
 * processada, o paciente não recebia nada e não havia como reprocessar.
 */
async function enviarResposta(
  numeroClinica: string,
  para: string,
  reply: Reply,
): Promise<boolean> {
  try {
    if (reply.opcoes?.length) {
      // Até 3 opções cabem em botões; acima disso, lista interativa.
      if (reply.opcoes.length <= MAX_BOTOES) {
        // O botão já mostra dia e hora: repetir no texto duplica a mensagem.
        await sendWhatsAppButtons(
          numeroClinica,
          para,
          semOpcoesRepetidas(reply.texto, reply.opcoes),
          reply.opcoes,
        );
      } else {
        await sendWhatsAppList(numeroClinica, para, reply.texto, reply.opcoes, reply.rotuloOpcoes);
      }
    } else {
      await sendWhatsAppText(numeroClinica, para, reply.texto);
    }
    return true;
  } catch (err) {
    // Nunca deixar o paciente sem resposta: se o formato interativo falhar,
    // manda o mesmo conteúdo como texto simples.
    logger.error({ err, to: mascararTelefone(para) }, "falha ao enviar resposta — tentando texto");
    const lista = (reply.opcoes ?? [])
      .map((o, i) => `${i + 1}. ${o.titulo}${o.descricao ? ` — ${o.descricao}` : ""}`)
      .join("\n");
    try {
      await sendWhatsAppText(
        numeroClinica,
        para,
        lista ? `${reply.texto}\n\n${lista}` : reply.texto,
      );
      return true;
    } catch (e) {
      logger.error({ err: e, to: mascararTelefone(para) }, "falha também no envio de texto");
      return false;
    }
  }
}

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

    if (
      mode === "subscribe" &&
      typeof token === "string" &&
      safeEqual(token, env.WHATSAPP_VERIFY_TOKEN)
    ) {
      res.status(200).send(texto(challenge));
      return;
    }
    res.sendStatus(403);
  });

  /**
   * Barra tudo que não vem assinado pela Meta. Middleware separado para que o
   * rate limit possa vir DEPOIS dele: assim uma enxurrada não assinada é
   * descartada aqui e não ocupa espaço no contador do limitador.
   */
  function exigirAssinatura(req: Request, res: Response, next: NextFunction): void {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.header("x-hub-signature-256");

    if (!rawBody || !verifyWhatsAppSignature(env.WHATSAPP_APP_SECRET, rawBody, signature)) {
      res.sendStatus(401);
      return;
    }
    next();
  }

  // 2) Recebimento de mensagens.
  router.post("/", exigirAssinatura, limiteWebhook, async (req: Request, res: Response) => {
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

        // Não responde na hora: o paciente costuma picotar o pedido em várias
        // mensagens. O lote é processado depois da janela de espera, e uma
        // conversa por vez (ver src/core/inbox.ts).
        const espera = (tenant.config.debounceSeconds ?? ESPERA_PADRAO_SEGUNDOS) * 1000;
        agruparMensagem(
          chaveConversa(tenant.id, parsed.from),
          {
            channel: "whatsapp",
            tenant,
            from: parsed.from,
            messageId: parsed.messageId,
            timestamp: parsed.timestamp,
            text: parsed.text,
            audioId: parsed.audioId,
            payload: parsed.payload,
            tipo: parsed.tipo,
          },
          espera,
          async (lote) => {
            // Libera as marcas de idempotência do lote. Elas são gravadas ANTES
            // do processamento (é o que serializa as reentregas simultâneas da
            // Meta), então sem isto uma falha aqui deixava as mensagens marcadas
            // para sempre: nunca respondidas e nunca reprocessáveis.
            const liberar = () =>
              Promise.all(lote.map((m) => unmarkMessageProcessed(m.messageId)));

            try {
              const reply = await handler.handle(lote);
              if (!reply) return;

              const entregue = await enviarResposta(
                tenant.whatsappPhoneNumberId,
                parsed.from,
                reply,
              );
              // O motor respondeu, mas nada chegou ao paciente.
              if (!entregue) await liberar();
            } catch (err) {
              logger.error(
                { err, to: mascararTelefone(parsed.from) },
                "falha ao processar o lote de mensagens",
              );
              await liberar();
            }
          },
        );
      }
    } catch (err) {
      logger.error({ err }, "erro ao processar webhook do WhatsApp");
    }
  });

  return router;
}
