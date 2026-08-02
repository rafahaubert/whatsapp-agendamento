/**
 * Follow-up de conversa abandonada — as condições que separam "vale cutucar"
 * de "cutucar seria constrangedor".
 */
import { describe, it, expect } from "vitest";
import { selecionarParaFollowUp, type ConversaAbandonada } from "../../src/jobs/followUp.js";

const agora = new Date("2026-08-02T15:00:00.000Z");
const atras = (minutos: number) => new Date(agora.getTime() - minutos * 60_000);

function conversa(over: Partial<ConversaAbandonada> & { id: string }): ConversaAbandonada {
  return {
    lastMessageAt: atras(45),
    followUpSentAt: null,
    humanHandoff: false,
    state: {},
    ultimaDirecao: "OUT",
    ...over,
  };
}

describe("selecionarParaFollowUp", () => {
  it("cutuca quem passou do silêncio configurado", () => {
    const lista = [conversa({ id: "parada", lastMessageAt: atras(45) })];
    expect(selecionarParaFollowUp(lista, agora, 30).map((c) => c.id)).toEqual(["parada"]);
  });

  it("não cutuca antes da hora", () => {
    const lista = [conversa({ id: "recente", lastMessageAt: atras(10) })];
    expect(selecionarParaFollowUp(lista, agora, 30)).toHaveLength(0);
  });

  it("nunca cutuca duas vezes (idempotência)", () => {
    const lista = [conversa({ id: "ja", followUpSentAt: atras(20) })];
    expect(selecionarParaFollowUp(lista, agora, 30)).toHaveLength(0);
  });

  // A recepção assumiu: o bot é mudo, inclusive para cutucar.
  it("não cutuca conversa em atendimento humano", () => {
    const lista = [conversa({ id: "humano", humanHandoff: true })];
    expect(selecionarParaFollowUp(lista, agora, 30)).toHaveLength(0);
  });

  // Silêncio depois de agendar não é abandono, é conversa que deu certo.
  it("não cutuca quem terminou agendando", () => {
    const lista = [
      conversa({ id: "agendou", state: { concluiuEm: atras(40).toISOString() } }),
    ];
    expect(selecionarParaFollowUp(lista, agora, 30)).toHaveLength(0);
  });

  // Se o PACIENTE falou por último e ficou sem resposta, o bot falhou —
  // mandar "quer seguir?" por cima seria absurdo.
  it("não cutuca quando quem falou por último foi o paciente", () => {
    const lista = [conversa({ id: "vacuo-do-bot", ultimaDirecao: "IN" })];
    expect(selecionarParaFollowUp(lista, agora, 30)).toHaveLength(0);
  });

  it("não cutuca conversa sem mensagem registrada", () => {
    const lista = [conversa({ id: "sem-log", ultimaDirecao: null })];
    expect(selecionarParaFollowUp(lista, agora, 30)).toHaveLength(0);
  });

  // Fora da janela de 24h da Meta a mensagem livre é recusada; só um template
  // passaria, e aí a automação perderia a graça (e ficaria cara).
  it("desiste de quem já saiu da janela de 24h da Meta", () => {
    const lista = [conversa({ id: "velha", lastMessageAt: atras(21 * 60) })];
    expect(selecionarParaFollowUp(lista, agora, 30)).toHaveLength(0);
  });

  it("ainda cutuca dentro da margem da janela", () => {
    const lista = [conversa({ id: "limite", lastMessageAt: atras(19 * 60) })];
    expect(selecionarParaFollowUp(lista, agora, 30).map((c) => c.id)).toEqual(["limite"]);
  });
});
