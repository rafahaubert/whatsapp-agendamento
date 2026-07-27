import type { ReplyOption } from "./types.js";

/** Acima disso a Meta não aceita botões e a resposta vira lista interativa. */
export const MAX_BOTOES = 3;

/**
 * "seg., 27/07, 12:00" → "seg270712:00" — só letras, números e ":", para
 * comparar o texto com o rótulo do botão sem tropeçar em pontuação.
 * "12h" e "12h30" viram "12:00" e "12:30".
 */
function chave(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/(\d{1,2})h(\d{2})/g, "$1:$2")
    .replace(/(\d{1,2})h\b/g, "$1:00")
    .replace(/[^\p{L}\p{N}:]/gu, "");
}

/** Linha que é item de lista ("1. 12:00", "- 12:00", "• 12:00"). */
const ITEM_DE_LISTA = /^\s*(?:\d+\s*[.)°º-]|[-–—•*])\s*(.+?)\s*$/;

/**
 * Tira do texto os horários que já vão como BOTÃO clicável.
 *
 * O paciente via a mesma informação duas vezes: a lista numerada no corpo da
 * mensagem e, logo abaixo, os mesmos horários como botões. Só remove linhas que
 * são item de lista E cujo conteúdo cabe dentro do rótulo de uma das opções —
 * "1. 12:00" sai; "1. 12:00 com a Dra. Ana" fica, porque diz algo a mais.
 *
 * Se sobrar só espaço em branco (o modelo escreveu apenas a lista), devolve o
 * texto original: melhor repetir do que mandar mensagem vazia.
 */
export function semOpcoesRepetidas(texto: string, opcoes: ReplyOption[]): string {
  const rotulos = opcoes.map((o) => chave(o.titulo)).filter(Boolean);
  if (!rotulos.length) return texto;

  const linhas = texto.split("\n").filter((linha) => {
    const item = ITEM_DE_LISTA.exec(linha);
    if (!item) return true;
    const conteudo = chave(item[1]);
    return !conteudo || !rotulos.some((r) => r.includes(conteudo));
  });

  const limpo = linhas
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return limpo || texto;
}
