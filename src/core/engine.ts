import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../ai/anthropic.js";
import { buildSystemPrompt } from "../ai/systemPrompt.js";
import { tools, executeTool, type ConversationContext } from "../ai/tools.js";
import {
  loadConversation,
  saveConversation,
  setHandoff,
  logMessage,
} from "../db/conversationRepository.js";
import { baixarMidia } from "../channels/whatsapp/media.js";
import { transcreverAudio, isTranscricaoConfigurada } from "../integrations/transcription.js";
import { confirmAppointment, cancelAppointment } from "../domain/scheduling.js";
import { logger } from "../shared/logger.js";
import type { IncomingMessage, MessageHandler, Reply, ReplyOption } from "../channels/types.js";

/** Fallback de modelo caso a config da clínica não defina um. */
const DEFAULT_MODEL = "claude-opus-4-8";
/** Limite de idas ao Claude por mensagem (evita loop de tool use infinito). */
const MAX_TURNS = 8;

/** Pedidos explícitos de atendimento humano (atalho, sem gastar LLM). */
const PEDE_ATENDENTE =
  /^\s*(atendente|humano|recep(c|ç)(a|ã)o)\s*$|falar com (um )?(atendente|humano|pessoa|recep)/i;

/** Horários oferecidos na última busca, para virarem opções clicáveis. */
interface HorarioOferecido {
  slotId: string;
  medico: string;
  unidade: string;
  inicio: string;
}

function extrairHorarios(resultado: unknown): HorarioOferecido[] {
  const r = resultado as { horarios?: HorarioOferecido[] } | null;
  return Array.isArray(r?.horarios) ? r.horarios : [];
}

/** listar_especialidades devolve um array simples de especialidades. */
function extrairEspecialidades(resultado: unknown): { name: string; priceParticular?: string | null }[] {
  return Array.isArray(resultado) && resultado[0]?.name ? resultado : [];
}

/**
 * Motor de conversa. Para cada mensagem recebida:
 *   1. resolve o conteúdo (texto, transcrição de áudio ou opção clicada);
 *   2. trata atalhos determinísticos (lembrete, atendente) sem chamar o modelo;
 *   3. roda o loop de tool use com o Claude sobre as ferramentas de domínio;
 *   4. persiste histórico/estado e devolve a resposta (com opções, se houver).
 */
export const conversationEngine: MessageHandler = {
  async handle(message: IncomingMessage): Promise<Reply | null> {
    const tenant = message.tenant;
    const conversa = await loadConversation(tenant.id, message.from);

    // ---------- 1. Conteúdo da mensagem ----------
    let texto = message.text?.trim() || null;

    if (message.audioId) {
      try {
        const midia = await baixarMidia(message.audioId);
        const transcrito = midia ? await transcreverAudio(midia.buffer, midia.mimeType) : null;
        if (transcrito) {
          texto = transcrito;
          logger.info({ from: message.from }, "áudio transcrito");
        }
      } catch (err) {
        logger.error({ err, from: message.from }, "falha ao processar áudio");
      }

      if (!texto) {
        await logMessage(tenant.id, message.from, "IN", "[áudio]", "PATIENT");
        const aviso = isTranscricaoConfigurada()
          ? "Não consegui entender o áudio 😕 Pode escrever, por favor?"
          : "Ainda não consigo ouvir áudios 😅 Pode escrever sua mensagem, por favor?";
        await logMessage(tenant.id, message.from, "OUT", aviso, "BOT");
        return { texto: aviso };
      }
    }

    if (!texto && !message.payload) {
      // Imagem, documento, figurinha…
      await logMessage(tenant.id, message.from, "IN", `[${message.tipo ?? "mídia"}]`, "PATIENT");
      const aviso = "Consigo ler mensagens de texto e áudio 🙂 Pode me escrever o que precisa?";
      await logMessage(tenant.id, message.from, "OUT", aviso, "BOT");
      return { texto: aviso };
    }

    await logMessage(tenant.id, message.from, "IN", texto ?? message.payload ?? "", "PATIENT");

    // ---------- 2. Atendimento humano em andamento: bot silencia ----------
    if (conversa.humanHandoff) {
      logger.info({ from: message.from }, "conversa em atendimento humano — bot não respondeu");
      return null;
    }

    // ---------- 3. Atalhos determinísticos ----------
    if (texto && PEDE_ATENDENTE.test(texto)) {
      await setHandoff(tenant.id, message.from, true);
      const aviso = "Certo! Já avisei a recepção — em instantes alguém da equipe fala com você. 🙂";
      await logMessage(tenant.id, message.from, "OUT", aviso, "BOT");
      return { texto: aviso };
    }

    // Botões do lembrete: CONFIRMAR / CANCELAR / REMARCAR + id do agendamento.
    if (message.payload) {
      const [acao, id] = message.payload.split(":");

      if (acao === "CONFIRMAR" && id) {
        const r = (await confirmAppointment(tenant, id)) as { erro?: string; inicio?: string };
        const resposta = r.erro
          ? r.erro
          : `Presença confirmada! ✅ Te esperamos ${r.inicio}. Até breve!`;
        await logMessage(tenant.id, message.from, "OUT", resposta, "BOT");
        return { texto: resposta };
      }

      if (acao === "CANCELAR" && id) {
        const r = (await cancelAppointment(tenant, id)) as { erro?: string };
        const resposta = r.erro
          ? r.erro
          : "Consulta cancelada. 👍 Se quiser remarcar, é só me chamar!";
        await logMessage(tenant.id, message.from, "OUT", resposta, "BOT");
        return { texto: resposta };
      }

      if (acao === "REMARCAR" && id) {
        texto = "Quero remarcar minha consulta.";
      } else if (acao === "SLOT" && id) {
        texto = `Escolho este horário: ${message.text ?? ""} (slotId: ${id})`;
      } else if (acao === "ESP" && id) {
        texto = `Quero ${id}.`;
      }
    }

    // ---------- 4. Conversa com o Claude ----------
    const messages: Anthropic.MessageParam[] = [
      ...conversa.history,
      { role: "user", content: texto ?? "" },
    ];

    const ctx: ConversationContext = {
      tenant,
      phone: message.from,
      patientId: conversa.state.patientId,
    };
    const model = tenant.config.ai.model || DEFAULT_MODEL;
    const system = buildSystemPrompt(tenant);

    let replyText = tenant.config.branding.fallbackMessage;
    let ultimosHorarios: HorarioOferecido[] = [];
    let ultimasEspecialidades: { name: string; priceParticular?: string | null }[] = [];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await anthropic.messages.create({
          model,
          max_tokens: 1024,
          system,
          tools,
          messages,
        });
        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "tool_use") {
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            let result: unknown;
            try {
              result = await executeTool(block.name, block.input, ctx);
              if (block.name === "listar_horarios") {
                const horarios = extrairHorarios(result);
                if (horarios.length) ultimosHorarios = horarios;
              }
              if (block.name === "listar_especialidades") {
                ultimasEspecialidades = extrairEspecialidades(result);
              }
              if (block.name === "agendar") {
                ultimosHorarios = []; // já escolheu
                ultimasEspecialidades = [];
              }
            } catch (err) {
              logger.error({ err, tool: block.name }, "erro ao executar ferramenta");
              result = { erro: "Falha ao executar a operação." };
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }
          messages.push({ role: "user", content: toolResults });
          continue; // volta ao Claude com os resultados
        }

        // Sem mais ferramentas: extrai o texto final.
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) replyText = text;
        break;
      }
    } catch (err) {
      logger.error({ err, tenant: tenant.slug, from: message.from }, "erro na conversa com o Claude");
      const aviso = tenant.config.branding.fallbackMessage;
      await logMessage(tenant.id, message.from, "OUT", aviso, "BOT");
      return { texto: aviso };
    }

    await saveConversation(tenant.id, message.from, messages, { patientId: ctx.patientId });

    // A ferramenta pediu atendimento humano.
    if (ctx.handoffRequested) await setHandoff(tenant.id, message.from, true);

    await logMessage(tenant.id, message.from, "OUT", replyText, "BOT");

    // Horários (ou especialidades) viram opções clicáveis — botões até 3, lista acima disso.
    if (ultimosHorarios.length) {
      // Dois profissionais podem ter o mesmo horário: oferecer o mesmo rótulo
      // duas vezes confunde o paciente (e a Meta rejeita títulos repetidos).
      const vistos = new Set<string>();
      const opcoes: ReplyOption[] = ultimosHorarios
        .filter((h) => (vistos.has(h.inicio) ? false : (vistos.add(h.inicio), true)))
        .slice(0, 10)
        .map((h) => ({
          id: `SLOT:${h.slotId}`,
          titulo: h.inicio,
          descricao: `${h.medico} · ${h.unidade}`,
        }));
      return { texto: replyText, opcoes, rotuloOpcoes: "Ver horários" };
    }

    if (ultimasEspecialidades.length) {
      const opcoes: ReplyOption[] = ultimasEspecialidades.slice(0, 10).map((e) => ({
        id: `ESP:${e.name}`,
        titulo: e.name,
        descricao: e.priceParticular ? `Particular: R$ ${e.priceParticular}` : undefined,
      }));
      return { texto: replyText, opcoes, rotuloOpcoes: "Ver especialidades" };
    }

    return { texto: replyText };
  },
};
