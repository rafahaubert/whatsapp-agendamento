import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../ai/anthropic.js";
import { buildSystemPrompt } from "../ai/systemPrompt.js";
import { buildTools, executeTool, type ConversationContext } from "../ai/tools.js";
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
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";
/** Limite de idas ao Claude por mensagem (evita loop de tool use infinito). */
const MAX_TURNS = 8;

/** Pedidos explícitos de atendimento humano (atalho, sem gastar LLM). */
const PEDE_ATENDENTE =
  /^\s*(atendente|humano|recep(c|ç)(a|ã)o)\s*$|falar com (um )?(atendente|humano|pessoa|recep)/i;

/** Ações de payload válidas. */
const ACOES_VALIDAS = new Set(["CONFIRMAR", "CANCELAR", "REMARCAR", "SLOT", "ESP"]);

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

/** O que uma mensagem recebida vira depois de resolvida (texto, áudio, opção). */
interface Resolvida {
  /** Texto utilizável pelo modelo, ou null se não deu para ler. */
  texto: string | null;
  /** O que registrar no log da caixa de entrada. */
  log: string;
  /** Aviso pronto quando não deu para ler (áudio ininteligível, imagem…). */
  aviso?: string;
}

// ---------- Rate limiting por telefone (sliding window) ----------
const rateLimitMap = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;      // 1 minuto
const RATE_MAX_MSG = 10;            // 10 mensagens por minuto

function isRateLimited(phone: string): boolean {
  const now = Date.now();
  const history = rateLimitMap.get(phone) ?? [];
  const recent = history.filter((t) => now - t < RATE_WINDOW_MS);

  if (recent.length >= RATE_MAX_MSG) {
    rateLimitMap.set(phone, recent);
    return true;
  }

  recent.push(now);
  rateLimitMap.set(phone, recent);
  return false;
}

// ---------- Timeout de conversa (histórico antigo é descartado) ----------
const CONVERSA_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

async function resolverConteudo(message: IncomingMessage): Promise<Resolvida> {
  const texto = message.text?.trim() || null;

  if (message.audioId) {
    try {
      const midia = await baixarMidia(message.audioId);
      const transcrito = midia ? await transcreverAudio(midia.buffer, midia.mimeType) : null;
      if (transcrito) {
        logger.info({ from: message.from }, "áudio transcrito");
        return { texto: transcrito, log: transcrito };
      }
    } catch (err) {
      logger.error({ err, from: message.from }, "falha ao processar áudio");
    }
    return {
      texto: null,
      log: "[áudio]",
      aviso: isTranscricaoConfigurada()
        ? "Não consegui entender o áudio 😕 Pode escrever, por favor?"
        : "Ainda não consigo ouvir áudios 😅 Pode escrever sua mensagem, por favor?",
    };
  }

  if (!texto && !message.payload) {
    // Imagem, documento, figurinha…
    return {
      texto: null,
      log: `[${message.tipo ?? "mídia"}]`,
      aviso: "Consigo ler mensagens de texto e áudio 🙂 Pode me escrever o que precisa?",
    };
  }

  // Botões do lembrete e opções clicáveis viram texto para o modelo.
  if (message.payload) {
    const parts = message.payload.split(":", 2);
    const acao = parts[0];
    const id = parts[1];

    if (!ACOES_VALIDAS.has(acao) || !id) {
      logger.warn({ payload: message.payload }, "payload inválido recebido");
      return { texto: null, log: `[payload inválido: ${message.payload}]` };
    }

    if (acao === "REMARCAR") return { texto: "Quero remarcar minha consulta.", log: texto ?? message.payload };
    if (acao === "SLOT") {
      return { texto: `Escolho este horário: ${message.text ?? ""} (slotId: ${id})`, log: texto ?? message.payload };
    }
    if (acao === "ESP") return { texto: `Quero ${id}.`, log: texto ?? message.payload };
  }

  return { texto, log: texto ?? message.payload ?? "" };
}

/**
 * Motor de conversa. Para cada LOTE de mensagens da mesma conversa:
 *   1. resolve o conteúdo de cada uma (texto, transcrição de áudio ou opção);
 *   2. trata atalhos determinísticos (lembrete, atendente) sem chamar o modelo;
 *   3. roda o loop de tool use com o Claude sobre as ferramentas de domínio;
 *   4. persiste histórico/estado e devolve a resposta (com opções, se houver).
 *
 * O lote vem de src/core/inbox.ts: o paciente costuma mandar duas ou três
 * mensagens seguidas, e todas devem virar UMA resposta só.
 */
export const conversationEngine: MessageHandler = {
  async handle(mensagens: IncomingMessage[]): Promise<Reply | null> {
    const primeira = mensagens[0];
    if (!primeira) return null;

    const tenant = primeira.tenant;
    const from = primeira.from;
    const conversa = await loadConversation(tenant.id, from);

    // ---------- Rate limiting ----------
    if (isRateLimited(from)) {
      logger.warn({ from, tenant: tenant.slug }, "rate limit excedido");
      return {
        texto: "Estou recebendo muitas mensagens suas. Vou pausar um momento para não me confundir. 😊",
      };
    }

    // ---------- Timeout de conversa: descarta histórico antigo ----------
    if (conversa.lastActivity && Date.now() - conversa.lastActivity.getTime() > CONVERSA_TTL_MS) {
      logger.info({ from, tenant: tenant.slug }, "conversa expirada — histórico resetado");
      conversa.history = [];
    }

    // ---------- 1. Conteúdo do lote ----------
    const resolvidas: Resolvida[] = [];
    for (const m of mensagens) {
      const r = await resolverConteudo(m);
      await logMessage(tenant.id, from, "IN", r.log, "PATIENT");
      resolvidas.push(r);
    }

    const textos = resolvidas.map((r) => r.texto).filter((t): t is string => Boolean(t));

    // Nada legível no lote: responde o aviso da primeira que falhou.
    if (textos.length === 0) {
      const aviso = resolvidas.find((r) => r.aviso)?.aviso;
      if (!aviso) return null;
      if (conversa.humanHandoff) return null;
      await logMessage(tenant.id, from, "OUT", aviso, "BOT");
      return { texto: aviso };
    }

    let texto = textos.join("\n");
    const naoLido = resolvidas.find((r) => !r.texto && r.aviso);
    if (naoLido) {
      texto += "\n(o paciente enviou também uma mensagem que não consegui ler — peça para reenviar por escrito)";
    }

    // ---------- 2. Atendimento humano em andamento: bot silencia ----------
    if (conversa.humanHandoff) {
      logger.info({ from }, "conversa em atendimento humano — bot não respondeu");
      return null;
    }

    // ---------- 3. Atalhos determinísticos ----------
    if (textos.some((t) => PEDE_ATENDENTE.test(t))) {
      await setHandoff(tenant.id, from, true);
      const aviso = "Certo! Já avisei a recepção — em instantes alguém da equipe fala com você. 🙂";
      await logMessage(tenant.id, from, "OUT", aviso, "BOT");
      return { texto: aviso };
    }

    // Botões do lembrete: CONFIRMAR / CANCELAR + id do agendamento.
    for (const m of mensagens) {
      if (!m.payload) continue;
      const parts = m.payload.split(":", 2);
      const acao = parts[0];
      const id = parts[1];

      if (!ACOES_VALIDAS.has(acao) || !id) continue;

      if (acao === "CONFIRMAR") {
        const r = (await confirmAppointment(tenant, id)) as { erro?: string; inicio?: string };
        const resposta = r.erro ? r.erro : `Presença confirmada! ✅ Te esperamos ${r.inicio}. Até breve!`;
        await logMessage(tenant.id, from, "OUT", resposta, "BOT");
        return { texto: resposta };
      }

      if (acao === "CANCELAR") {
        const r = (await cancelAppointment(tenant, id)) as { erro?: string };
        const resposta = r.erro ? r.erro : "Consulta cancelada. 👍 Se quiser remarcar, é só me chamar!";
        await logMessage(tenant.id, from, "OUT", resposta, "BOT");
        return { texto: resposta };
      }
    }

    // ---------- 4. Conversa com o Claude ----------
    // Data/hora atualizada a cada interação — fora do system prompt para
    // permitir prompt caching (economia de ~90% no custo de input).
    const now = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tenant.config.businessHours.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date());

    const contextoDataHora = `[Contexto: hoje é ${now}. Fuso: ${tenant.config.businessHours.timezone}.]`;

    const messages: Anthropic.MessageParam[] = [
      ...conversa.history,
      { role: "user", content: `${contextoDataHora}\n\n${texto}` },
    ];

    const ctx: ConversationContext = {
      tenant,
      phone: from,
      patientId: conversa.state.patientId,
      // A trava de confirmação de `agendar` olha para tudo o que o paciente
      // acabou de dizer — o "sim" pode vir seguido de um "obrigado".
      ultimaMensagemPaciente: textos.join("\n"),
    };

    const model = tenant.config.ai.model || DEFAULT_MODEL;
    const system = buildSystemPrompt(tenant);
    const tools = buildTools(tenant);

    let replyText = tenant.config.branding.fallbackMessage;
    let ultimosHorarios: HorarioOferecido[] = [];
    let ultimasEspecialidades: { name: string; priceParticular?: string | null }[] = [];
    // Consumo do turno inteiro (várias idas ao modelo) — base de custo por clínica.
    const consumo = { input: 0, output: 0 };

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
        consumo.input += response.usage?.input_tokens ?? 0;
        consumo.output += response.usage?.output_tokens ?? 0;

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
              if (block.name === "agendar" && !(result as { erro?: string })?.erro) {
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
      logger.error({ err, tenant: tenant.slug, from }, "erro na conversa com o Claude");
      const aviso = tenant.config.branding.fallbackMessage;
      // O turno falhou, mas o que já foi consumido até aqui foi cobrado.
      await logMessage(tenant.id, from, "OUT", aviso, "BOT", consumo);
      return { texto: aviso };
    }

    // ---------- CORREÇÃO: setHandoff ANTES de saveConversation ----------
    // Evita race condition onde o paciente manda msg entre save e setHandoff.
    if (ctx.handoffRequested) {
      await setHandoff(tenant.id, from, true);
    }

    await saveConversation(tenant.id, from, messages, { patientId: ctx.patientId });

    // ---------- CORREÇÃO: logar consumo também no sucesso ----------
    await logMessage(tenant.id, from, "OUT", replyText, "BOT", consumo);

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

    // Especialidades viram opções apenas quando o agente REALMENTE apresenta a
    // lista. Se ele só consultou o catálogo para entender a necessidade do
    // paciente (triagem), anexar a lista atrapalharia a conversa.
    if (ultimasEspecialidades.length) {
      const textoLower = replyText.toLowerCase();
      const citadas = ultimasEspecialidades.filter((e) =>
        textoLower.includes(e.name.toLowerCase()),
      ).length;

      if (citadas >= 2) {
        const opcoes: ReplyOption[] = ultimasEspecialidades.slice(0, 10).map((e) => ({
          id: `ESP:${e.name}`,
          titulo: e.name,
          descricao: e.priceParticular ? `Particular: R$ ${e.priceParticular}` : undefined,
        }));
        return { texto: replyText, opcoes, rotuloOpcoes: "Ver especialidades" };
      }
    }

    return { texto: replyText };
  },
};
