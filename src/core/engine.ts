import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../ai/anthropic.js";
import { buildSystemPrompt } from "../ai/systemPrompt.js";
import { tools, executeTool, type ConversationContext } from "../ai/tools.js";
import { loadConversation, saveConversation } from "../db/conversationRepository.js";
import { logger } from "../shared/logger.js";
import type { IncomingMessage, MessageHandler } from "../channels/types.js";

/** Fallback de modelo caso a config da clínica não defina um. */
const DEFAULT_MODEL = "claude-opus-4-8";
/** Limite de idas ao Claude por mensagem (evita loop de tool use infinito). */
const MAX_TURNS = 8;

/**
 * Motor de conversa. Para cada mensagem recebida:
 *   1. carrega o histórico + estado da Conversation (memória entre mensagens);
 *   2. roda um loop de tool use com o Claude, executando as ferramentas de
 *      domínio no banco até o modelo produzir a resposta final;
 *   3. persiste o histórico atualizado e devolve o texto para o canal enviar.
 */
export const conversationEngine: MessageHandler = {
  async handle(message: IncomingMessage): Promise<string | null> {
    const tenant = message.tenant;
    const { history, state } = await loadConversation(tenant.id, message.from);

    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: message.text },
    ];

    const ctx: ConversationContext = {
      tenant,
      phone: message.from,
      patientId: state.patientId,
    };
    const model = tenant.config.ai.model || DEFAULT_MODEL;
    const system = buildSystemPrompt(tenant);

    let replyText = tenant.config.branding.fallbackMessage;

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
      return tenant.config.branding.fallbackMessage;
    }

    await saveConversation(tenant.id, message.from, messages, { patientId: ctx.patientId });
    return replyText;
  },
};
