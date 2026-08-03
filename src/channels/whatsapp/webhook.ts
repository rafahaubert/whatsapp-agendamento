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
import { markMessageProcessed } from "../../db/idempotency.js";
import { agruparMensagem, chaveConversa } from "../../core/inbox.js";
import { logger } from "../../shared/logger.js";
import { mascararTelefone } from "../../shared/pii.js";
import { safeEqual } from "../../shared/comparacao.js";
import { limiteWebhook } from "../../shared/rateLimit.js";
import type { MessageHandler, Reply } from "../types.js";
import type { WhatsAppWebhookBody } from "./types.js";

/** Espera padrão antes de responder, quando a clínica não configurou uma. */
const ESPERA_PADRAO_SEGUNDOS = 8;

/** Envia a resposta do motor, com degradação para texto puro se o formato interativo falhar. */
async function enviarResposta(
  numeroClinica: string,
  para: string,
  reply: Reply,
): Promise<void> {
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
  } catch (err) {
    // Nunca deixar o paciente sem resposta: se o formato interativo falhar,
    // manda o mesmo conteúdo como texto simples.
    logger.error({ err, to: mascararTelefone(para) }, "falha ao enviar resposta — tentando texto");
    const lista = (reply.opcoes ?? [])
      .map((o, i) => `${i + 1}. ${o.titulo}${o.descricao ? ` — ${o.descricao}` : ""}`)
      .join("\n");
    await sendWhatsAppText(
      numeroClinica,
      para,
      lista ? `${reply.texto}\n\n${lista}` : reply.texto,
    ).catch((e) => logger.error({ err: e }, "falha também no envio de texto"));
  }
}

/**
 * Router do canal WhatsApp. Recebe o `MessageHandler` por injeção: é o que
 * mantém o canal ignorante do motor de conversa — em produção entra o
 * `conversationEngine`, e nos testes entra um handler falso, sem Claude nem
 * banco.
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
      res.status(200).send(String(challenge));
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
            try {
              const reply = await handler.handle(lote);
              if (reply) await enviarResposta(tenant.whatsappPhoneNumberId, parsed.from, reply);
            } catch (err) {
              logger.error(
                { err, to: mascararTelefone(parsed.from) },
                "falha ao processar o lote de mensagens",
              );
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
