import { describe, it, expect } from "vitest";
import { ehConfirmacao, ehPedidoDeConfirmacao } from "../../src/shared/confirmacao.js";

describe("ehConfirmacao", () => {
  it("aceita as formas comuns de dizer sim", () => {
    for (const t of [
      "sim",
      "Sim, pode agendar",
      "simm",
      "pode ser",
      "pode marcar",
      "confirmo",
      "Confirmado!",
      "ok",
      "beleza",
      "blz",
      "perfeito",
      "tá bom",
      "isso mesmo",
      "claro",
      "👍",
    ]) {
      expect(ehConfirmacao(t), t).toBe(true);
    }
  });

  it("REGRESSÃO: a conversa que agendou sem confirmação não passa", () => {
    // O paciente respondeu a forma de pagamento e emendou uma pergunta —
    // em nenhum momento autorizou o agendamento.
    expect(ehConfirmacao("particular")).toBe(false);
    expect(ehConfirmacao("qual o valor?")).toBe(false);
    expect(ehConfirmacao("particular\nqual o valor?")).toBe(false);
  });

  it("escolher um horário não é confirmar", () => {
    expect(ehConfirmacao("Escolho este horário: seg., 27/07, 16:00 (slotId: abc123)")).toBe(false);
  });

  it("nega quando a frase começa com negativa", () => {
    expect(ehConfirmacao("não")).toBe(false);
    expect(ehConfirmacao("não pode ser segunda")).toBe(false);
    expect(ehConfirmacao("nao, prefiro terça")).toBe(false);
  });

  it("trata vazio e nulo como não confirmado", () => {
    expect(ehConfirmacao("")).toBe(false);
    expect(ehConfirmacao(null)).toBe(false);
    expect(ehConfirmacao(undefined)).toBe(false);
    expect(ehConfirmacao("   ")).toBe(false);
  });

  it("não confunde perguntas com confirmação", () => {
    expect(ehConfirmacao("tem segunda as 16h30?")).toBe(false);
    expect(ehConfirmacao("teria que ser um pouco mais tarde")).toBe(false);
    expect(ehConfirmacao("me manda outras opções")).toBe(false);
    expect(ehConfirmacao("estou com um pouco de dor de dente")).toBe(false);
  });

  it("os botões de sim/não do pedido de confirmação são lidos como se espera", () => {
    expect(ehConfirmacao("Sim, pode agendar.")).toBe(true);
    expect(ehConfirmacao("Não, quero outro horário.")).toBe(false);
  });
});

describe("ehPedidoDeConfirmacao", () => {
  it("reconhece o pedido de aval final, do jeito que o agente escreve", () => {
    for (const t of [
      "Perfeito! Deixa eu confirmar:\n\n*Clínico Geral* | *Dr. Pedro* | *Sexta, 31/07 às 15:30*\n\nPosso confirmar?",
      "Ótimo! Confirmando então:\n\n*Clínico Geral*\n\nPosso agendar?",
      "Posso marcar para você?",
      "Podemos confirmar?",
    ]) {
      expect(ehPedidoDeConfirmacao(t), t).toBe(true);
    }
  });

  it("mensagem que oferece horários NÃO é pedido de confirmação", () => {
    for (const t of [
      "Ótimo! Tenho estes horários com o Clínico Geral para sexta-feira 👇",
      "Sim! Tenho estes outros horários mais tarde para você 👇",
      "Os horários que mostrei têm o *Dr. Pedro* e o *Dr. Arnaldo*. Qual você prefere?",
      "Pelo que você descreveu, o ideal é *Clínico Geral*. Posso seguir com isso?",
    ]) {
      expect(ehPedidoDeConfirmacao(t), t).toBe(false);
    }
  });

  it("trata vazio e nulo como não pedido", () => {
    expect(ehPedidoDeConfirmacao("")).toBe(false);
    expect(ehPedidoDeConfirmacao(null)).toBe(false);
    expect(ehPedidoDeConfirmacao(undefined)).toBe(false);
  });
});
