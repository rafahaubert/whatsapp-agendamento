import { describe, it, expect } from "vitest";
import {
  domingoDePascoa,
  feriadosNacionais,
  feriadosNaJanela,
  intervaloDoFeriado,
} from "../../src/domain/feriados.js";

const TZ = "America/Sao_Paulo";
const dataDe = (nome: string, ano: number) =>
  feriadosNacionais(ano).find((f) => f.nome === nome)?.data;

describe("domingoDePascoa", () => {
  // Datas conferíveis em qualquer calendário. É a âncora de Carnaval, Sexta-feira
  // Santa e Corpus Christi — errar aqui erra os quatro de uma vez.
  it("acerta anos conhecidos", () => {
    expect(domingoDePascoa(2024).toISODate()).toBe("2024-03-31");
    expect(domingoDePascoa(2025).toISODate()).toBe("2025-04-20");
    expect(domingoDePascoa(2026).toISODate()).toBe("2026-04-05");
    expect(domingoDePascoa(2027).toISODate()).toBe("2027-03-28");
    expect(domingoDePascoa(2030).toISODate()).toBe("2030-04-21");
  });
});

describe("feriadosNacionais", () => {
  it("traz os fixos no lugar certo", () => {
    expect(dataDe("Confraternização Universal", 2026)).toBe("2026-01-01");
    expect(dataDe("Tiradentes", 2026)).toBe("2026-04-21");
    expect(dataDe("Natal", 2026)).toBe("2026-12-25");
  });

  // Feriado nacional desde a Lei 14.759/2023 — uma lista montada antes disso
  // deixaria a clínica aberta num dia em que ela fecha.
  it("inclui a Consciência Negra", () => {
    expect(dataDe("Consciência Negra", 2026)).toBe("2026-11-20");
  });

  it("posiciona os móveis a partir da Páscoa", () => {
    // Páscoa 2026 = 05/04.
    expect(dataDe("Carnaval (terça)", 2026)).toBe("2026-02-17");
    expect(dataDe("Carnaval (segunda)", 2026)).toBe("2026-02-16");
    expect(dataDe("Sexta-feira Santa", 2026)).toBe("2026-04-03");
    expect(dataDe("Corpus Christi", 2026)).toBe("2026-06-04");
  });

  it("os móveis mudam de lugar a cada ano", () => {
    expect(dataDe("Carnaval (terça)", 2025)).toBe("2025-03-04");
    expect(dataDe("Carnaval (terça)", 2027)).toBe("2027-02-09");
  });

  it("vem ordenado por data", () => {
    const datas = feriadosNacionais(2026).map((f) => f.data);
    expect([...datas].sort()).toEqual(datas);
  });

  // Carnaval e Corpus Christi não são feriado nacional por lei, mas quase toda
  // clínica fecha. Fica marcado para a clínica escolher.
  it("marca o que é facultativo", () => {
    const porNome = new Map(feriadosNacionais(2026).map((f) => [f.nome, f.facultativo]));
    expect(porNome.get("Carnaval (terça)")).toBe(true);
    expect(porNome.get("Corpus Christi")).toBe(true);
    expect(porNome.get("Natal")).toBe(false);
    expect(porNome.get("Sexta-feira Santa")).toBe(false);
  });
});

describe("feriadosNaJanela", () => {
  it("pega só o que cai dentro da janela", () => {
    // De 10/02/2026 por 15 dias: alcança o Carnaval (16 e 17/02).
    const r = feriadosNaJanela(new Date("2026-02-10T12:00:00Z"), 15, TZ, true);
    expect(r.map((f) => f.data)).toEqual(["2026-02-16", "2026-02-17"]);
  });

  it("respeita a escolha de ignorar os facultativos", () => {
    const r = feriadosNaJanela(new Date("2026-02-10T12:00:00Z"), 15, TZ, false);
    expect(r).toHaveLength(0);
  });

  // A janela de geração da agenda cruza a virada do ano o tempo todo: gerar 60
  // dias em dezembro alcança janeiro. Varrer só o ano corrente perderia o Natal
  // OU o Ano Novo, dependendo do dia em que o cron rodasse.
  it("atravessa a virada do ano", () => {
    const r = feriadosNaJanela(new Date("2026-12-20T12:00:00Z"), 30, TZ, false);
    expect(r.map((f) => f.data)).toEqual(["2026-12-25", "2027-01-01"]);
  });

  it("janela vazia não devolve nada", () => {
    expect(feriadosNaJanela(new Date("2026-07-01T12:00:00Z"), 10, TZ, true)).toHaveLength(0);
  });
});

describe("intervaloDoFeriado", () => {
  it("cobre o dia inteiro no fuso da clínica", () => {
    const { startsAt, endsAt } = intervaloDoFeriado(
      { data: "2026-12-25", nome: "Natal", facultativo: false },
      TZ,
    );
    // São Paulo é UTC-3: o dia começa às 03:00 UTC.
    expect(startsAt.toISOString()).toBe("2026-12-25T03:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-12-26T02:59:59.999Z");
  });
});
