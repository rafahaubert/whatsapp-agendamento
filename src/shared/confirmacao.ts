/**
 * O paciente confirmou?
 *
 * Existe porque o agente chegou a agendar enquanto o paciente ainda fazia
 * perguntas ("particular", "qual o valor?"). O prompt pede a confirmação; isto
 * aqui garante — é checado antes de a ferramenta `agendar` rodar.
 *
 * Deliberadamente conservador: na dúvida devolve `false` e o agente pede um
 * "sim". Perguntar de novo custa uma mensagem; agendar sem querer custa uma
 * cadeira vazia na clínica.
 */

/** Afirmações que valem como "pode agendar". */
const AFIRMACOES = [
  /\bsi+m+\b/, // sim, simm, siim
  /\bisso\b/,
  /\bexato\b|\bexatamente\b/,
  /\bpode\b/, // pode ser, pode agendar, pode marcar, pode sim
  /\bconfirm\w*/, // confirmo, confirma, confirmado, confirmar
  /\bfechado\b|\bfechou\b/,
  /\bok\b|\bokay\b|\bokey\b/,
  /\bbeleza\b|\bblz\b/,
  /\bperfeito\b|\botimo\b/,
  /\bta bom\b|\btudo bem\b|\bta certo\b|\bcerto\b/,
  /\bclaro\b/,
  /\baceito\b/,
  /\bbora\b|\bvamos\b|\bvamo\b/,
  /\bpositivo\b/,
  /[👍👌✅]/u,
];

/** Começos que derrubam a confirmação, mesmo que venha um "pode" depois. */
const NEGACAO = /^(nao|nops?|nem|negativo)\b/;

function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .replace(/\s+/g, " ");
}

/**
 * `true` só quando a fala do paciente é um aceite claro.
 *
 * Escolha do horário ("Escolho este horário: …", gerado pelo clique no botão)
 * NÃO conta: escolher quando é diferente de confirmar que pode agendar.
 */
export function ehConfirmacao(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const t = normalizar(texto);
  if (!t) return false;
  if (NEGACAO.test(t)) return false;
  return AFIRMACOES.some((re) => re.test(t));
}

/**
 * Formas de o AGENTE pedir o aval final do agendamento. Só o pedido em si —
 * "posso seguir com isso?" (usado na triagem de especialidade) fica de fora
 * de propósito: ali ainda não há horário escolhido.
 */
const PEDIDOS_DE_CONFIRMACAO = [
  /\bposso (confirmar|agendar|marcar)\b/,
  /\bpodemos (confirmar|agendar|marcar)\b/,
  /\bposso seguir com o agendamento\b/,
  /\b(confirmo|confirmando|confirmamos) (entao|assim)\b/,
  /\bdeixa eu confirmar\b/,
  /\bconfirma (pra|para) (voce|mim)\b/,
];

/**
 * A mensagem do agente é o pedido de confirmação do agendamento?
 *
 * Serve para NÃO reoferecer a agenda junto do "Posso confirmar?": o paciente
 * já escolheu o horário, e ver os mesmos botões de novo faz parecer que a
 * escolha se perdeu — ele reclica, e a conversa volta uma casa.
 */
export function ehPedidoDeConfirmacao(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const t = normalizar(texto);
  if (!t) return false;
  return PEDIDOS_DE_CONFIRMACAO.some((re) => re.test(t));
}
