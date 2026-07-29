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
import { chaveConversa } from "./inbox.js";
import { baixarMidia } from "../channels/whatsapp/media.js";
import { transcreverAudio, isTranscricaoConfigurada } from "../integrations/transcription.js";
import {
  confirmAppointment,
  cancelAppointment,
  periodosReaisDaAgenda,
  pacientesDoTelefone,
} from "../domain/scheduling.js";
import { ehPedidoDeConfirmacao } from "../shared/confirmacao.js";
import type { Periodo } from "../domain/horarios.js";
import { logger } from "../shared/logger.js";
import type { IncomingMessage, MessageHandler, Reply, ReplyOption } from "../channels/types.js";

/**
 * Fallback de modelo caso a config da clínica não defina um. Igual ao padrão do
 * formulário do painel (src/admin/configForm.ts) — o valor anterior
 * ("claude-3-5-sonnet-20241022") foi aposentado pela Anthropic e devolvia 404
 * em toda mensagem de clínica sem modelo configurado.
 */
const DEFAULT_MODEL = "claude-haiku-4-5";
/** Limite de idas ao Claude por mensagem (evita loop de tool use infinito). */
const MAX_TURNS = 8;

/** Pedidos explícitos de atendimento humano (atalho, sem gastar LLM). */
const PEDE_ATENDENTE =
  /^\s*(atendente|humano|recep(c|ç)(a|ã)o)\s*$|falar com (um )?(atendente|humano|pessoa|recep)/i;

/** Ações de payload válidas. */
const ACOES_VALIDAS = new Set(["CONFIRMAR", "CANCELAR", "REMARCAR", "SLOT", "ESP", "SIM", "NAO"]);

/**
 * O que acompanha um "Posso confirmar?": sim ou não, num toque.
 *
 * Antes iam os mesmos horários da última busca, e o paciente que já tinha
 * escolhido via a agenda de novo — como se nada tivesse sido registrado.
 */
const OPCOES_CONFIRMACAO: ReplyOption[] = [
  { id: "SIM:1", titulo: "Sim, pode agendar" },
  { id: "NAO:1", titulo: "Quero outro horário" },
];

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

// ---------- Rate limiting por CONVERSA (sliding window) ----------
const RATE_WINDOW_MS = 60_000;      // 1 minuto
const RATE_MAX_MSG = 10;            // 10 lotes por minuto
const RATE_FAXINA_MS = 5 * 60_000;  // varre o mapa a cada 5 minutos

interface JanelaEnvio {
  /** Momentos dos lotes recebidos, mais novos que RATE_WINDOW_MS. */
  marcas: number[];
  /** Quando o aviso de excesso saiu — para não repetir na mesma janela. */
  avisadoEm?: number;
}

/** Chave = (clínica, telefone): o mesmo paciente pode falar com duas clínicas. */
const rateLimitMap = new Map<string, JanelaEnvio>();
let ultimaFaxina = Date.now();

/** Sem isto o mapa guarda para sempre todo telefone que já escreveu. */
function faxinaRateLimit(now: number): void {
  if (now - ultimaFaxina < RATE_FAXINA_MS) return;
  ultimaFaxina = now;
  for (const [chave, janela] of rateLimitMap) {
    const viva = janela.marcas.some((t) => now - t < RATE_WINDOW_MS);
    if (!viva) rateLimitMap.delete(chave);
  }
}

/**
 * Passou do limite? `avisar` sai UMA vez por janela — repetir o aviso a cada
 * mensagem do flood custa envio na Meta e faz o bot parecer quebrado.
 */
function checarRateLimit(chave: string): { limitado: boolean; avisar: boolean } {
  const now = Date.now();
  faxinaRateLimit(now);

  const janela = rateLimitMap.get(chave) ?? { marcas: [] };
  const marcas = janela.marcas.filter((t) => now - t < RATE_WINDOW_MS);
  const limitado = marcas.length >= RATE_MAX_MSG;

  // A marca entra mesmo quando limitado: enquanto o flood continuar, a janela
  // não drena e a conversa segue barrada até um minuto inteiro de silêncio.
  marcas.push(now);

  const avisar =
    limitado && (janela.avisadoEm === undefined || now - janela.avisadoEm >= RATE_WINDOW_MS);

  rateLimitMap.set(chave, {
    marcas,
    avisadoEm: avisar ? now : janela.avisadoEm,
  });

  return { limitado, avisar };
}

/** Só para testes: zera as janelas entre casos. */
export function limparRateLimit(): void {
  rateLimitMap.clear();
  ultimaFaxina = Date.now();
}

/**
 * Fuso da clínica que o runtime aceita. O painel já valida na gravação; isto é
 * a rede de baixo, para uma config antiga inválida não derrubar o lote inteiro
 * (`Intl.DateTimeFormat` lança fora do try/catch da conversa).
 */
function fusoDaClinica(timezone: string): string {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: timezone });
    return timezone;
  } catch {
    logger.error({ timezone }, "timezone inválido na config da clínica — usando UTC");
    return "UTC";
  }
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
    if (acao === "SIM") return { texto: "Sim, pode agendar.", log: texto ?? message.payload };
    if (acao === "NAO") return { texto: "Não, quero outro horário.", log: texto ?? message.payload };
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
    const rate = checarRateLimit(chaveConversa(tenant.id, from));
    if (rate.limitado) {
      logger.warn({ from, tenant: tenant.slug }, "rate limit excedido");
      // Em atendimento humano o bot é mudo — nem para avisar de excesso.
      if (!rate.avisar || conversa.humanHandoff) return null;
      const aviso =
        "Estou recebendo muitas mensagens suas. Vou pausar um momento para não me confundir. 😊";
      await logMessage(tenant.id, from, "OUT", aviso, "BOT");
      return { texto: aviso };
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
    // Data/hora atualizada a cada interação — fora do system prompt para que
    // ele seja byte a byte igual entre as mensagens (pré-requisito do prompt
    // caching; o `cache_control` em si ainda não é enviado — ver systemPrompt.ts).
    const fuso = fusoDaClinica(tenant.config.businessHours.timezone);
    const now = new Intl.DateTimeFormat("pt-BR", {
      timeZone: fuso,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date());

    const contextoDataHora = `[Contexto: hoje é ${now}. Fuso: ${fuso}.]`;

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

    // Quem já é da casa não repete nome e CPF: o WhatsApp já provou o número e
    // o cadastro está no banco. Um cadastro no telefone = paciente entra na
    // conversa já identificado (só confirma que a consulta é para ele); vários
    // (telefone de família) = quem escolhe é o paciente, no prompt. Acessório:
    // se a leitura falhar, o fluxo cai no de sempre, pedindo nome e CPF.
    let cadastrados: string[] = [];
    try {
      const doTelefone = await pacientesDoTelefone(tenant.id, from);
      cadastrados = doTelefone.map((p) => p.name);
      if (!ctx.patientId && doTelefone.length === 1) ctx.patientId = doTelefone[0].id;
    } catch (err) {
      logger.error({ err, tenant: tenant.slug }, "falha ao buscar o cadastro do telefone");
    }

    const model = tenant.config.ai.model || DEFAULT_MODEL;

    // Os períodos que a agenda dos profissionais realmente gera. Sem eles o
    // prompt anuncia o horário de funcionamento da clínica, que pode prometer
    // uma tarde que nenhum profissional atende. É acessório: se a leitura
    // falhar, o prompt cai no horário anunciado, como antes.
    let periodosReais: Periodo[] | undefined;
    try {
      periodosReais = await periodosReaisDaAgenda(tenant);
    } catch (err) {
      logger.error({ err, tenant: tenant.slug }, "falha ao apurar os períodos reais da agenda");
    }

    // `identificado` olha o ESTADO da conversa, não o ctx: um paciente que já
    // veio resolvido de turnos anteriores não deve ser reapresentado ("este
    // telefone tem mais de um cadastro") depois de a conversa ter decidido
    // para quem é a consulta.
    const system = buildSystemPrompt(tenant, periodosReais, {
      identificado: Boolean(conversa.state.patientId),
      nomes: cadastrados,
    });
    const tools = buildTools(tenant);

    let replyText = tenant.config.branding.fallbackMessage;
    let ultimosHorarios: HorarioOferecido[] = [];
    let ultimasEspecialidades: { name: string; priceParticular?: string | null }[] = [];
    /** A consulta saiu neste turno? Depois disso não há mais o que confirmar. */
    let concluiu = false;
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
              if (
                (block.name === "agendar" || block.name === "remarcar") &&
                !(result as { erro?: string })?.erro
              ) {
                concluiu = true;
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

    // O handoff é gravado ANTES do histórico: se o processo cair entre as duas
    // escritas, o pior caso é o bot mudo com o histórico velho — nunca o bot
    // respondendo por cima da recepção. (A fila por conversa em inbox.ts já
    // impede que o lote seguinte leia o estado no meio do caminho.)
    if (ctx.handoffRequested) {
      await setHandoff(tenant.id, from, true);
    }

    await saveConversation(tenant.id, from, messages, { patientId: ctx.patientId });

    // Consumo do turno vai junto da resposta — é a base de custo por clínica.
    await logMessage(tenant.id, from, "OUT", replyText, "BOT", consumo);

    // Pedindo o aval final, a agenda sai de cena: o horário já foi escolhido e
    // repetir os botões convida a escolher de novo (foi o que aconteceu quando
    // o paciente trocou de profissional — voltou a agenda inteira junto do
    // "Posso confirmar?"). No lugar dela, sim ou não num toque.
    if (!concluiu && ehPedidoDeConfirmacao(replyText)) {
      return { texto: replyText, opcoes: OPCOES_CONFIRMACAO };
    }

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
