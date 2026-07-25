import type { IncomingMessage, MessageHandler } from "../channels/types.js";

/**
 * PLACEHOLDER da Fase 1.
 *
 * Só existe para tornar o canal testável ponta a ponta: qualquer mensagem
 * recebida é respondida com a saudação configurada da clínica. Na Fase 2 este
 * arquivo dá lugar ao motor de conversa (máquina de estados + Claude), que
 * lerá/atualizará a `Conversation` e conduzirá o agendamento.
 */
export const greetingHandler: MessageHandler = {
  async handle(message: IncomingMessage): Promise<string> {
    return message.tenant.config.branding.greetingMessage;
  },
};
