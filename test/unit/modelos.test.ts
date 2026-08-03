import { describe, it, expect } from "vitest";
import {
  MODELOS_OFERECIDOS,
  MODELO_PADRAO,
  PERFIS,
  cacheProvavel,
  estimarTokensPrefixo,
  perfilDoModelo,
  precoDoModelo,
} from "../../src/ai/modelos.js";

describe("perfilDoModelo", () => {
  it("cai no padrão quando o modelo é desconhecido", () => {
    expect(perfilDoModelo("modelo-que-nao-existe")).toBe(PERFIS[MODELO_PADRAO]);
  });

  it("todo modelo oferecido no painel tem perfil", () => {
    for (const id of MODELOS_OFERECIDOS) {
      expect(PERFIS[id], id).toBeDefined();
    }
  });

  // Omitir `thinking` significa "sem pensar" num modelo e "pensamento
  // adaptativo" noutro. Com max_tokens fixo — teto de pensamento + texto
  // SOMADOS — herdar o default errado truncava a resposta ao paciente.
  it("nenhum modelo depende do default de pensamento", () => {
    for (const id of MODELOS_OFERECIDOS) {
      expect(PERFIS[id].pensamento, id).toBeDefined();
    }
  });

  // Onde o pensamento está ligado ele divide o teto de saída com a resposta.
  it("quem pensa tem teto de saída maior", () => {
    for (const id of MODELOS_OFERECIDOS) {
      const p = PERFIS[id];
      if (p.pensamento.type === "adaptive") {
        expect(p.maxTokens, id).toBeGreaterThan(1024);
      }
    }
  });

  // O Haiku 4.5 devolve erro quando recebe `effort`.
  it("esforço só vai para quem aceita", () => {
    expect(PERFIS["claude-haiku-4-5"].esforco).toBeUndefined();
  });
});

describe("precoDoModelo", () => {
  it("usa o preço de tabela quando não há promoção", () => {
    expect(precoDoModelo("claude-haiku-4-5")).toEqual({ entrada: 1, saida: 5 });
    expect(precoDoModelo("claude-opus-5")).toEqual({ entrada: 5, saida: 25 });
  });

  // REGRESSÃO: a tabela chumbava US$ 3 para o Sonnet 5, que está em promoção
  // até 31/08/2026 — custo superestimado em 50%. Um número chumbado do outro
  // lado continuaria barato depois que a promoção vencesse.
  it("aplica a promoção do Sonnet 5 e a solta na data certa", () => {
    expect(precoDoModelo("claude-sonnet-5", new Date("2026-08-03T00:00:00Z"))).toEqual({
      entrada: 2,
      saida: 10,
    });
    expect(precoDoModelo("claude-sonnet-5", new Date("2026-08-31T23:00:00Z"))).toEqual({
      entrada: 2,
      saida: 10,
    });
    expect(precoDoModelo("claude-sonnet-5", new Date("2026-09-01T00:00:01Z"))).toEqual({
      entrada: 3,
      saida: 15,
    });
  });

  it("modelo desconhecido cai no preço do padrão", () => {
    expect(precoDoModelo("inventado")).toEqual(precoDoModelo(MODELO_PADRAO));
  });
});

describe("cacheProvavel", () => {
  // O ponto todo: o mínimo NÃO acompanha a geração do modelo. O Haiku 4.5, o
  // mais barato, é o que mais exige (4096); o Opus 5 exige 512. Não dá para
  // deduzir — e abaixo do mínimo a API não cacheia e não avisa.
  it("o mínimo não é monotônico entre modelos", () => {
    expect(PERFIS["claude-haiku-4-5"].minPrefixoCache).toBe(4096);
    expect(PERFIS["claude-sonnet-5"].minPrefixoCache).toBe(1024);
    expect(PERFIS["claude-opus-4-8"].minPrefixoCache).toBe(1024);
    expect(PERFIS["claude-opus-5"].minPrefixoCache).toBe(512);
  });

  // O prefixo do projeto (ferramentas + prompt) fica na casa dos 3,5k tokens:
  // logo ABAIXO do corte do modelo padrão e acima do de todos os outros.
  it("um prefixo de ~3,5k não cacheia no Haiku e cacheia no resto", () => {
    const prefixo = 3500;
    expect(cacheProvavel("claude-haiku-4-5", prefixo)).toBe(false);
    expect(cacheProvavel("claude-sonnet-5", prefixo)).toBe(true);
    expect(cacheProvavel("claude-opus-4-8", prefixo)).toBe(true);
    expect(cacheProvavel("claude-opus-5", prefixo)).toBe(true);
  });

  it("no limite exato já conta como cacheável", () => {
    expect(cacheProvavel("claude-haiku-4-5", 4096)).toBe(true);
    expect(cacheProvavel("claude-haiku-4-5", 4095)).toBe(false);
  });
});

describe("estimarTokensPrefixo", () => {
  it("cresce com o prompt e com as ferramentas", () => {
    const soPrompt = estimarTokensPrefixo("a".repeat(4000), null);
    const comFerramentas = estimarTokensPrefixo("a".repeat(4000), [{ name: "x".repeat(400) }]);
    expect(soPrompt).toBe(1001); // 4000 caracteres + `""` do JSON de null
    expect(comFerramentas).toBeGreaterThan(soPrompt);
  });

  it("aguenta ferramentas ausentes", () => {
    expect(estimarTokensPrefixo("", undefined)).toBeGreaterThanOrEqual(0);
  });
});
