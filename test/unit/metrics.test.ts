import { describe, it, expect } from "vitest";
import {
  foraDoHorario,
  calcularCustoUSD,
  diagnosticarCache,
  calcularFaturamento,
  calcularOcupacao,
  calcularUsoDoPlano,
  inicioDoMes,
  type ConsultaFaturavel,
} from "../../src/admin/metrics.js";

const TZ = "America/Sao_Paulo";
const dias = {
  0: null, // domingo fechado
  1: { open: "08:00", close: "18:00" },
  2: { open: "08:00", close: "18:00" },
  3: { open: "08:00", close: "18:00" },
  4: { open: "08:00", close: "18:00" },
  5: { open: "08:00", close: "18:00" },
  6: { open: "08:00", close: "12:00" }, // sábado meio período
};

/** Monta um instante no fuso da clínica (UTC-3). */
const local = (dataISO: string) => new Date(`${dataISO}-03:00`);

describe("foraDoHorario", () => {
  it("dentro do expediente = false", () => {
    // segunda-feira, 10:00
    expect(foraDoHorario(local("2026-07-27T10:00:00"), TZ, dias)).toBe(false);
  });

  it("antes de abrir e depois de fechar = true", () => {
    expect(foraDoHorario(local("2026-07-27T07:30:00"), TZ, dias)).toBe(true);
    expect(foraDoHorario(local("2026-07-27T20:00:00"), TZ, dias)).toBe(true);
  });

  it("no minuto do fechamento já conta como fora", () => {
    expect(foraDoHorario(local("2026-07-27T18:00:00"), TZ, dias)).toBe(true);
    expect(foraDoHorario(local("2026-07-27T17:59:00"), TZ, dias)).toBe(false);
  });

  it("dia fechado (domingo) = sempre fora", () => {
    expect(foraDoHorario(local("2026-07-26T10:00:00"), TZ, dias)).toBe(true);
  });

  it("respeita o horário reduzido do sábado", () => {
    expect(foraDoHorario(local("2026-08-01T10:00:00"), TZ, dias)).toBe(false);
    expect(foraDoHorario(local("2026-08-01T14:00:00"), TZ, dias)).toBe(true);
  });

  it("usa o fuso da clínica, não o do servidor", () => {
    // 23:00 UTC de segunda = 20:00 em São Paulo → fora do expediente
    expect(foraDoHorario(new Date("2026-07-27T23:00:00Z"), TZ, dias)).toBe(true);
    // 12:00 UTC = 09:00 em São Paulo → dentro
    expect(foraDoHorario(new Date("2026-07-27T12:00:00Z"), TZ, dias)).toBe(false);
  });
});

describe("calcularCustoUSD", () => {
  // Haiku: US$ 1/Mtok de entrada, US$ 5/Mtok de saída.
  const zerado = { entrada: 0, saida: 0, cacheEscrita: 0, cacheLeitura: 0 };

  it("cobra entrada e saída pelo preço do modelo", () => {
    const r = calcularCustoUSD(
      { ...zerado, entrada: 1_000_000, saida: 1_000_000 },
      "claude-haiku-4-5",
    );
    expect(r.custoUSD).toBeCloseTo(6, 6);
    expect(r.economiaCacheUSD).toBe(0);
  });

  // O ponto que mais erra: escrever no cache custa MAIS que input normal.
  it("cobra a escrita de cache a 1,25x", () => {
    const r = calcularCustoUSD({ ...zerado, cacheEscrita: 1_000_000 }, "claude-haiku-4-5");
    expect(r.custoUSD).toBeCloseTo(1.25, 6);
    // Escrita não é economia — é o investimento que a torna possível.
    expect(r.economiaCacheUSD).toBe(0);
  });

  it("cobra a leitura de cache a 0,1x e credita a economia", () => {
    const r = calcularCustoUSD({ ...zerado, cacheLeitura: 1_000_000 }, "claude-haiku-4-5");
    expect(r.custoUSD).toBeCloseTo(0.1, 6);
    expect(r.economiaCacheUSD).toBeCloseTo(0.9, 6);
  });

  it("usa o preço do modelo caro quando é ele que está configurado", () => {
    // Opus: US$ 5/Mtok de entrada. Sem promoção, o preço de tabela vale sempre.
    const r = calcularCustoUSD({ ...zerado, entrada: 1_000_000 }, "claude-opus-5");
    expect(r.custoUSD).toBeCloseTo(5, 6);
  });

  it("cai no preço do Haiku quando o modelo é desconhecido", () => {
    const r = calcularCustoUSD({ ...zerado, entrada: 1_000_000 }, "modelo-que-nao-existe");
    expect(r.custoUSD).toBeCloseTo(1, 6);
  });

  // REGRESSÃO: o Sonnet 5 está em preço promocional até 31/08/2026. A tabela
  // cobrava os US$ 3 cheios, superestimando o custo da clínica em 50% — e, pior,
  // um número chumbado continuaria barato depois que a promoção vencesse.
  it("respeita a promoção enquanto ela vale e volta ao preço cheio depois", () => {
    const durante = calcularCustoUSD(
      { ...zerado, entrada: 1_000_000 },
      "claude-sonnet-5",
      new Date("2026-08-03T12:00:00Z"),
    );
    expect(durante.custoUSD).toBeCloseTo(2, 6);

    const depois = calcularCustoUSD(
      { ...zerado, entrada: 1_000_000 },
      "claude-sonnet-5",
      new Date("2026-09-01T12:00:00Z"),
    );
    expect(depois.custoUSD).toBeCloseTo(3, 6);
  });
});

describe("diagnosticarCache", () => {
  const zerado = { entrada: 0, saida: 0, cacheEscrita: 0, cacheLeitura: 0 };

  it("sem volume suficiente não arrisca um veredito", () => {
    expect(diagnosticarCache({ ...zerado, entrada: 5000 }, 10, 3)).toBe(null);
  });

  it("sem consumo nenhum também não arrisca", () => {
    expect(diagnosticarCache(zerado, 10, 50)).toBe(null);
  });

  // REGRESSÃO: é a diferença entre "o cache não compensou" e "o cache nunca foi
  // tentado". Os dois apareciam como economia zero no painel.
  it("com volume e leitura zerada, o cache não está pegando", () => {
    expect(diagnosticarCache({ ...zerado, entrada: 200_000 }, 10, 50)).toBe(false);
  });

  it("qualquer leitura de cache já prova que está pegando", () => {
    expect(diagnosticarCache({ ...zerado, entrada: 200_000, cacheLeitura: 1 }, 10, 50)).toBe(true);
  });
});

describe("calcularFaturamento", () => {
  const c = (over: Partial<ConsultaFaturavel> = {}): ConsultaFaturavel => ({
    status: "COMPLETED",
    precoCentavos: 15000,
    especialidade: "Clínico Geral",
    paymentType: "PARTICULAR",
    ...over,
  });

  it("soma o que já aconteceu e o que está marcado, separados", () => {
    const r = calcularFaturamento([
      c({ status: "COMPLETED" }),
      c({ status: "SCHEDULED" }),
      c({ status: "CONFIRMED" }),
    ]);
    expect(r.realizadoCentavos).toBe(15000);
    expect(r.previstoCentavos).toBe(30000);
  });

  it("cancelada e falta não faturam", () => {
    const r = calcularFaturamento([c({ status: "CANCELLED" }), c({ status: "NO_SHOW" })]);
    expect(r.realizadoCentavos).toBe(0);
    expect(r.previstoCentavos).toBe(0);
  });

  // Somar o preço particular de um atendimento por convênio inflaria o
  // faturamento com dinheiro que nunca entrou — o valor depende do plano e do
  // repasse, que o sistema não conhece.
  it("convênio fica de fora", () => {
    const r = calcularFaturamento([c({ paymentType: "HEALTH_PLAN" })]);
    expect(r.realizadoCentavos).toBe(0);
    expect(r.semPreco).toBe(0);
  });

  // REGRESSÃO EM POTENCIAL: tratar preço ausente como zero somaria em silêncio
  // para baixo, e a clínica acharia que fatura menos do que fatura.
  it("consulta sem preço é contada à parte, não como zero", () => {
    const r = calcularFaturamento([c(), c({ precoCentavos: null }), c({ precoCentavos: null })]);
    expect(r.realizadoCentavos).toBe(15000);
    expect(r.semPreco).toBe(2);
  });

  it("agrupa por especialidade, da maior para a menor", () => {
    const r = calcularFaturamento([
      c({ especialidade: "Limpeza", precoCentavos: 10000 }),
      c({ especialidade: "Canal", precoCentavos: 90000 }),
      c({ especialidade: "Limpeza", precoCentavos: 10000 }),
    ]);
    expect(r.porEspecialidade).toEqual([
      { especialidade: "Canal", centavos: 90000, consultas: 1 },
      { especialidade: "Limpeza", centavos: 20000, consultas: 2 },
    ]);
  });

  // O agrupamento é do REALIZADO: misturar o previsto faria a clínica ler como
  // receita algo que ainda pode ser cancelado.
  it("o agrupamento por especialidade não inclui o previsto", () => {
    const r = calcularFaturamento([c({ status: "SCHEDULED", especialidade: "Canal" })]);
    expect(r.porEspecialidade).toEqual([]);
    expect(r.previstoCentavos).toBe(15000);
  });

  it("lista vazia não quebra", () => {
    expect(calcularFaturamento([])).toEqual({
      realizadoCentavos: 0,
      previstoCentavos: 0,
      semPreco: 0,
      porEspecialidade: [],
    });
  });
});

describe("calcularOcupacao", () => {
  it("calcula a porcentagem preenchida", () => {
    expect(calcularOcupacao(1, 3)).toBe(25);
    expect(calcularOcupacao(3, 1)).toBe(75);
    expect(calcularOcupacao(4, 0)).toBe(100);
    expect(calcularOcupacao(0, 4)).toBe(0);
  });

  // Sem agenda gerada, 0% e 100% seriam igualmente falsos.
  it("sem agenda nenhuma, não arrisca um número", () => {
    expect(calcularOcupacao(0, 0)).toBe(null);
  });
});

describe("calcularUsoDoPlano", () => {
  const plano = { nome: "Profissional", cotaMensal: 600, excedenteCentavos: 150 };

  it("sem plano configurado, não há o que cobrar nem avisar", () => {
    expect(calcularUsoDoPlano(500, undefined)).toBe(null);
  });

  it("dentro da cota, sem excedente", () => {
    const r = calcularUsoDoPlano(300, plano)!;
    expect(r.percentual).toBe(50);
    expect(r.excedentes).toBe(0);
    expect(r.excedenteCentavos).toBe(0);
    expect(r.perto).toBe(false);
    expect(r.estourou).toBe(false);
  });

  // A proposta comercial PROMETE avisar antes de virar fatura. Descobrir o
  // excedente no boleto é a pior hora possível — e era o que acontecia, porque
  // nada contava.
  it("avisa a partir de 80% da cota", () => {
    expect(calcularUsoDoPlano(479, plano)!.perto).toBe(false);
    expect(calcularUsoDoPlano(480, plano)!.perto).toBe(true);
    expect(calcularUsoDoPlano(600, plano)!.perto).toBe(true);
  });

  it("passando da cota, calcula o excedente em dinheiro", () => {
    const r = calcularUsoDoPlano(610, plano)!;
    expect(r.excedentes).toBe(10);
    expect(r.excedenteCentavos).toBe(1500); // 10 × R$ 1,50
    expect(r.estourou).toBe(true);
    // Já estourou: não é mais "perto", é passado.
    expect(r.perto).toBe(false);
  });

  it("exatamente na cota ainda não é excedente", () => {
    const r = calcularUsoDoPlano(600, plano)!;
    expect(r.excedentes).toBe(0);
    expect(r.estourou).toBe(false);
  });

  // Plano sob consulta: o consumo do mês continua valendo para a conversa
  // comercial, mas percentual e excedente não fazem sentido.
  it("cota zero = sem limite", () => {
    const r = calcularUsoDoPlano(5000, { ...plano, cotaMensal: 0 })!;
    expect(r.percentual).toBe(null);
    expect(r.excedentes).toBe(0);
    expect(r.estourou).toBe(false);
    expect(r.usados).toBe(5000);
  });
});

describe("inicioDoMes", () => {
  // A cota é do MÊS CIVIL, que é o ciclo que a fatura cobra — não da janela de
  // dias que o resto do relatório usa.
  it("volta ao primeiro instante do mês no fuso da clínica", () => {
    const r = inicioDoMes(new Date("2026-08-15T12:00:00Z"), TZ);
    // São Paulo é UTC-3: 01/08 00:00 local = 31/07 03:00 UTC.
    expect(r.toISOString()).toBe("2026-08-01T03:00:00.000Z");
  });

  it("no primeiro dia do mês, não volta para o mês anterior", () => {
    const r = inicioDoMes(new Date("2026-08-01T15:00:00Z"), TZ);
    expect(r.toISOString()).toBe("2026-08-01T03:00:00.000Z");
  });
});
