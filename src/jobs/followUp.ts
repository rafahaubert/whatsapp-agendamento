/**
 * Follow-up de conversa abandonada.
 *
 * O paciente escreve, o bot pergunta o nome — e ele some. A intenção já estava
 * ali; o que faltou foi uma segunda batida na porta. Este job manda UMA, e só
 * uma, quando a conversa fica em silêncio por X minutos com a palavra do lado
 * do paciente.
 *
 * Barato de propósito: dentro da janela de 24h da Meta a mensagem é LIVRE, sem
 * template aprovado e sem o custo por template dos outros jobs. Por isso o
 * corte de 20h — fora da janela precisaria de template, e aí não valeria a pena.
 *
 * Idempotente: grava `followUpSentAt` e nunca cutuca a mesma conversa duas vezes.
 */
import { prisma } from "../db/client.js";
import { sendWhatsAppText } from "../channels/whatsapp/client.js";
import { logMessage, type ConversationState } from "../db/conversationRepository.js";
import { logger } from "../shared/logger.js";
import { mascararTelefone } from "../shared/pii.js";
import { dentroDaJanelaDeEnvio, getTenantConfig } from "./janela.js";

/** Minutos de silêncio antes de cutucar, quando a clínica não configurou. */
const MINUTOS_PADRAO = 30;

/**
 * Teto da janela de 24h da Meta, com margem.
 *
 * Passou disso, mensagem livre é recusada e só um template entraria — o que
 * anularia a graça deste job. A margem de 4h protege contra cron atrasado:
 * melhor não cutucar do que descobrir a recusa no envio.
 */
const LIMITE_JANELA_META_MS = 20 * 60 * 60 * 1000;

/** A cutucada padrão: curta, sem cobrança, e devolve a decisão ao paciente. */
const MENSAGEM_PADRAO =
  "Oi! Vi que nossa conversa parou por aqui 🙂 Quer que eu siga com o seu agendamento?";

export interface ConversaAbandonada {
  id: string;
  lastMessageAt: Date;
  followUpSentAt: Date | null;
  humanHandoff: boolean;
  /** Estado da conversa já desserializado (traz `concluiuEm`). */
  state: ConversationState;
  /** Quem falou por último: "OUT" = o bot (paciente deixou no vácuo). */
  ultimaDirecao: "IN" | "OUT" | null;
}

/**
 * Regra pura (testável): quais conversas merecem a cutucada agora.
 *
 * Elegível = ninguém cutucou ainda, a recepção não assumiu, o silêncio passou
 * de `minutesAfter` mas ainda cabe na janela da Meta, a conversa não terminou
 * em agendamento e quem falou por último foi o BOT.
 *
 * A última condição é a que evita o pior erro: se o PACIENTE falou por último e
 * ficou sem resposta, o problema é outro (o bot falhou) e mandar "quer seguir?"
 * por cima seria absurdo.
 */
export function selecionarParaFollowUp<T extends ConversaAbandonada>(
  conversas: T[],
  agora: Date,
  minutesAfter: number,
): T[] {
  const silencioMinimo = new Date(agora.getTime() - minutesAfter * 60_000);
  const limiteJanela = new Date(agora.getTime() - LIMITE_JANELA_META_MS);

  return conversas.filter(
    (c) =>
      c.followUpSentAt == null &&
      !c.humanHandoff &&
      c.ultimaDirecao === "OUT" &&
      c.state.concluiuEm == null &&
      c.lastMessageAt <= silencioMinimo &&
      c.lastMessageAt > limiteJanela,
  );
}

/** Lê o estado da conversa sem derrubar o job por um JSON corrompido. */
function lerEstado(state: string): ConversationState {
  try {
    return JSON.parse(state) as ConversationState;
  } catch {
    return {};
  }
}

/** Executa o follow-up de todas as clínicas com o recurso ligado. */
export async function enviarFollowUps(agora = new Date()): Promise<{ enviados: number; falhas: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let enviados = 0;
  let falhas = 0;

  for (const tenant of tenants) {
    const config = getTenantConfig(tenant);
    if (!config) continue;

    const cfg = config.followUp;
    if (!cfg?.enabled) continue;

    // Cutucar às 3h da manhã transforma ajuda em incômodo.
    if (!dentroDaJanelaDeEnvio(tenant.timezone, agora)) {
      logger.debug({ tenant: tenant.slug }, "fora da janela de envio de follow-up");
      continue;
    }

    const minutos = cfg.minutesAfter > 0 ? cfg.minutesAfter : MINUTOS_PADRAO;
    const silencioMinimo = new Date(agora.getTime() - minutos * 60_000);
    const limiteJanela = new Date(agora.getTime() - LIMITE_JANELA_META_MS);
    const mensagem = cfg.message?.trim() || MENSAGEM_PADRAO;

    // Paginação por cursor: uma clínica grande pode ter muita conversa parada.
    let cursor: string | undefined;
    const pageSize = 200;

    do {
      const candidatos = await prisma.conversation.findMany({
        where: {
          tenantId: tenant.id,
          followUpSentAt: null,
          humanHandoff: false,
          lastMessageAt: { lte: silencioMinimo, gt: limiteJanela },
        },
        take: pageSize,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: "asc" },
      });

      for (const conversa of candidatos) {
        // Quem falou por último decide se cutucar faz sentido. Vem do log da
        // caixa de entrada, que é onde a direção de cada mensagem é registrada.
        const ultima = await prisma.message.findFirst({
          where: { tenantId: tenant.id, phone: conversa.patientPhone },
          orderBy: { createdAt: "desc" },
          select: { direction: true },
        });

        const elegivel = selecionarParaFollowUp(
          [
            {
              id: conversa.id,
              lastMessageAt: conversa.lastMessageAt,
              followUpSentAt: conversa.followUpSentAt,
              humanHandoff: conversa.humanHandoff,
              state: lerEstado(conversa.state),
              ultimaDirecao: (ultima?.direction as "IN" | "OUT" | undefined) ?? null,
            },
          ],
          agora,
          minutos,
        );
        if (elegivel.length === 0) continue;

        try {
          await sendWhatsAppText(tenant.whatsappPhoneNumberId, conversa.patientPhone, mensagem);

          // A marca vai DEPOIS do envio: se o processo cair no meio, o pior
          // caso é uma cutucada repetida no ciclo seguinte — nunca uma conversa
          // marcada como cutucada sem que o paciente tenha recebido nada.
          await prisma.conversation.update({
            where: { id: conversa.id },
            data: { followUpSentAt: new Date() },
          });

          // Entra na caixa de entrada do painel como qualquer fala do bot: a
          // recepção precisa ver que o sistema falou, senão a conversa parece
          // ter se mexido sozinha.
          await logMessage(tenant.id, conversa.patientPhone, "OUT", mensagem, "BOT");
          enviados++;
        } catch (err) {
          falhas++;
          logger.error(
            { err, tenant: tenant.slug, to: mascararTelefone(conversa.patientPhone) },
            "falha ao enviar follow-up",
          );
        }
      }

      cursor = candidatos.length === pageSize ? candidatos[candidatos.length - 1].id : undefined;
    } while (cursor);
  }

  if (enviados || falhas) {
    logger.info({ enviados, falhas }, "follow-ups processados");
  }
  return { enviados, falhas };
}
