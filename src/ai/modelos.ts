/**
 * O que muda de um modelo do Claude para outro — e que o código precisa saber
 * ANTES de chamar a API.
 *
 * Três coisas moram aqui porque as três estavam espalhadas (ou faltando) e as
 * três custam dinheiro quando erram:
 *
 * 1. PREÇO — a base de custo por clínica no painel.
 *
 * 2. PREFIXO MÍNIMO DE CACHE — abaixo dele a API NÃO cacheia e NÃO avisa:
 *    devolve `cache_creation_input_tokens: 0` como se estivesse tudo certo. O
 *    mínimo não acompanha a geração do modelo (o Haiku 4.5, o mais barato, é o
 *    que mais exige — 4096, contra 512 do Opus 5), então não dá para deduzir:
 *    tem de estar escrito.
 *
 * 3. PENSAMENTO — omitir o parâmetro `thinking` significa coisas OPOSTAS
 *    conforme o modelo. No Haiku 4.5 e no Opus 4.8 é "sem pensar"; no Sonnet 5
 *    e no Opus 5 LIGA o pensamento adaptativo. Como `max_tokens` é o teto de
 *    pensamento + texto somados, herdar o default errado corta a resposta ao
 *    paciente no meio da frase. Por isso nada aqui é omitido por conveniência.
 *
 * Um detalhe do nosso caso que decide o item 3: este agente vive de ferramentas
 * (agendar, cancelar, remarcar). Com o pensamento DESLIGADO, o Sonnet 5 e o
 * Opus 5 às vezes escrevem a chamada de ferramenta como texto comum em vez de
 * emitirem o bloco de tool use — o turno "dá certo", a ferramenta nunca roda e
 * ninguém é avisado. Num bot de agendamento isso é o paciente sair achando que
 * marcou. Nesses dois modelos o pensamento fica ligado no esforço mais baixo.
 */

/** O que vai no campo `thinking` da requisição. */
export type Pensamento = { type: "adaptive" } | { type: "disabled" };

export interface PerfilModelo {
  /** Como o painel apresenta o modelo. */
  rotulo: string;
  /** US$ por milhão de tokens de entrada (preço de tabela). */
  entrada: number;
  /** US$ por milhão de tokens de saída (preço de tabela). */
  saida: number;
  /**
   * Preço promocional com data de validade. Fica separado do preço de tabela
   * para o painel voltar sozinho ao cheio quando a promoção vencer — um número
   * chumbado viraria custo subestimado sem ninguém perceber.
   */
  promocao?: { entrada: number; saida: number; ate: string };
  /** Tokens mínimos de prefixo para o prompt caching pegar neste modelo. */
  minPrefixoCache: number;
  /** O que mandar em `thinking` — sempre explícito, nunca herdado do default. */
  pensamento: Pensamento;
  /** Esforço. Só os modelos que aceitam (o Haiku 4.5 devolve erro). */
  esforco?: "low" | "medium" | "high";
  /**
   * Teto de saída. Onde o pensamento está ligado ele divide este teto com o
   * texto da resposta — daí o valor maior nesses modelos.
   */
  maxTokens: number;
}

/** Modelo usado quando a clínica não configurou nenhum (ou configurou um inválido). */
export const MODELO_PADRAO = "claude-haiku-4-5";

export const PERFIS: Record<string, PerfilModelo> = {
  "claude-haiku-4-5": {
    rotulo: "Haiku 4.5 — mais barato",
    entrada: 1,
    saida: 5,
    // O maior mínimo da tabela. Nosso prefixo (ferramentas + prompt) fica na
    // casa dos 3,5k tokens, ou seja: LOGO ABAIXO do corte. Ver `cacheProvavel`.
    minPrefixoCache: 4096,
    pensamento: { type: "disabled" },
    maxTokens: 1024,
  },
  "claude-sonnet-5": {
    rotulo: "Sonnet 5 — equilíbrio",
    entrada: 3,
    saida: 15,
    promocao: { entrada: 2, saida: 10, ate: "2026-08-31" },
    minPrefixoCache: 1024,
    // Pensamento ligado de propósito — ver o cabeçalho do arquivo.
    pensamento: { type: "adaptive" },
    esforco: "low",
    maxTokens: 4096,
  },
  "claude-opus-4-8": {
    rotulo: "Opus 4.8 — capaz",
    entrada: 5,
    saida: 25,
    minPrefixoCache: 1024,
    pensamento: { type: "disabled" },
    maxTokens: 1024,
  },
  "claude-opus-5": {
    rotulo: "Opus 5 — mais capaz",
    // Mesmo preço do Opus 4.8 e mais capaz; e com o menor mínimo de cache da
    // tabela (512), é o único da lista em que o nosso prefixo cacheia com folga.
    entrada: 5,
    saida: 25,
    minPrefixoCache: 512,
    pensamento: { type: "adaptive" },
    esforco: "low",
    maxTokens: 4096,
  },
};

/** Ordem em que o painel oferece os modelos (do mais barato ao mais capaz). */
export const MODELOS_OFERECIDOS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-5",
] as const;

/** Perfil do modelo, caindo no padrão quando o id não é conhecido. */
export function perfilDoModelo(modelo: string): PerfilModelo {
  return PERFIS[modelo] ?? PERFIS[MODELO_PADRAO];
}

/**
 * Preço vigente na data — respeita a promoção enquanto ela valer.
 * Regra pura (testável): é o que multiplica o consumo no painel.
 */
export function precoDoModelo(
  modelo: string,
  quando: Date = new Date(),
): { entrada: number; saida: number } {
  const perfil = perfilDoModelo(modelo);
  const promo = perfil.promocao;
  if (promo && quando.getTime() <= Date.parse(`${promo.ate}T23:59:59Z`)) {
    return { entrada: promo.entrada, saida: promo.saida };
  }
  return { entrada: perfil.entrada, saida: perfil.saida };
}

/**
 * Estimativa de tokens do prefixo cacheado (ferramentas + system prompt).
 *
 * É uma aproximação deliberada: 1 token ≈ 4 caracteres em português. Serve para
 * UMA decisão — avisar no painel quando o prefixo não alcança o mínimo do
 * modelo escolhido — e não para prever custo. A resposta definitiva está no
 * banco: `cache_read_tokens` da tabela `messages` (ver `cacheProvavel`).
 */
export function estimarTokensPrefixo(system: string, ferramentas: unknown): number {
  const caracteres = system.length + JSON.stringify(ferramentas ?? "").length;
  return Math.round(caracteres / 4);
}

/**
 * O prompt caching tem chance de pegar com este prefixo neste modelo?
 *
 * `false` significa que a API vai ignorar o `cache_control` em silêncio — o
 * painel mostraria economia zero sem explicação. É a diferença entre "o cache
 * não compensou" e "o cache nunca foi tentado".
 */
export function cacheProvavel(modelo: string, tokensPrefixo: number): boolean {
  return tokensPrefixo >= perfilDoModelo(modelo).minPrefixoCache;
}
