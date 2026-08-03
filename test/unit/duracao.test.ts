import { describe, it, expect } from "vitest";
import {
  duracaoDoProcedimento,
  intervaloEntreConsultas,
  estaOcupado,
  type Ocupacao,
} from "../../src/db/seed.js";
import { reaisParaCentavos, lerDuracao } from "../../src/admin/tenantAdmin.js";

describe("duracaoDoProcedimento", () => {
  // O ponto todo: uma limpeza de 15 minutos e um canal de 90 deixam de ocupar o
  // mesmo slot. Antes havia UM valor global por clínica.
  it("a especialidade manda sobre o padrão da clínica", () => {
    expect(duracaoDoProcedimento(90, 30)).toBe(90);
    expect(duracaoDoProcedimento(15, 30)).toBe(15);
  });

  it("sem duração própria, herda o padrão da clínica", () => {
    expect(duracaoDoProcedimento(null, 30)).toBe(30);
    expect(duracaoDoProcedimento(undefined, 45)).toBe(45);
  });

  // Zero ou negativo faria o cursor do gerador nunca avançar — laço infinito
  // travando a renovação da agenda inteira.
  it("valor inválido cai num padrão seguro em vez de travar o gerador", () => {
    expect(duracaoDoProcedimento(0, 30)).toBe(30);
    expect(duracaoDoProcedimento(-10, 30)).toBe(30);
    expect(duracaoDoProcedimento(null, 0)).toBe(30);
    expect(duracaoDoProcedimento(null, Number.NaN)).toBe(30);
  });

  it("arredonda fração para minuto inteiro", () => {
    expect(duracaoDoProcedimento(30.6, 30)).toBe(31);
  });
});

describe("intervaloEntreConsultas", () => {
  it("sem configuração, não há folga (comportamento antigo)", () => {
    expect(intervaloEntreConsultas(undefined)).toBe(0);
    expect(intervaloEntreConsultas(0)).toBe(0);
  });

  it("respeita o valor configurado", () => {
    expect(intervaloEntreConsultas(15)).toBe(15);
  });

  it("negativo não encolhe a agenda", () => {
    expect(intervaloEntreConsultas(-30)).toBe(0);
  });
});

describe("estaOcupado", () => {
  const ocupacoes: Ocupacao[] = [
    {
      doctorId: "d1",
      startsAt: new Date("2026-08-10T14:00:00Z"),
      endsAt: new Date("2026-08-10T15:00:00Z"),
    },
  ];
  const em = (h: string) => new Date(`2026-08-10T${h}:00Z`);

  it("detecta sobreposição direta", () => {
    expect(estaOcupado(em("14:30"), em("15:30"), "d1", ocupacoes)).toBe(true);
  });

  it("encostar sem sobrepor é livre quando não há intervalo", () => {
    expect(estaOcupado(em("15:00"), em("16:00"), "d1", ocupacoes)).toBe(false);
    expect(estaOcupado(em("13:00"), em("14:00"), "d1", ocupacoes)).toBe(false);
  });

  it("não confunde profissionais diferentes", () => {
    expect(estaOcupado(em("14:30"), em("15:30"), "d2", ocupacoes)).toBe(false);
  });

  // A folga vale dos DOIS lados: uma consulta das 14h às 15h com 15 minutos de
  // intervalo ocupa das 13h45 às 15h15. Nem a anterior encosta, nem a seguinte.
  it("o intervalo estende a ocupação nas duas pontas", () => {
    expect(estaOcupado(em("15:00"), em("16:00"), "d1", ocupacoes, 15)).toBe(true);
    expect(estaOcupado(em("15:15"), em("16:00"), "d1", ocupacoes, 15)).toBe(false);
    expect(estaOcupado(em("13:00"), em("14:00"), "d1", ocupacoes, 15)).toBe(true);
    expect(estaOcupado(em("13:00"), em("13:45"), "d1", ocupacoes, 15)).toBe(false);
  });
});

describe("reaisParaCentavos", () => {
  // O relatório de faturamento precisa de um número; `priceParticular` é texto
  // livre ("A partir de R$ 120") e serve só para o paciente ler.
  it("lê o que o brasileiro digita de verdade", () => {
    expect(reaisParaCentavos("150")).toBe(15000);
    expect(reaisParaCentavos("150,00")).toBe(15000);
    expect(reaisParaCentavos("150,50")).toBe(15050);
    expect(reaisParaCentavos("R$ 150,00")).toBe(15000);
    expect(reaisParaCentavos("1.250,50")).toBe(125050);
    expect(reaisParaCentavos("R$ 1.250")).toBe(125000);
  });

  // Somar um número inventado seria pior que não ter o número.
  it("devolve null quando não dá para ler um valor", () => {
    expect(reaisParaCentavos("A partir de R$ 120")).toBe(null);
    expect(reaisParaCentavos("consultar")).toBe(null);
    expect(reaisParaCentavos("")).toBe(null);
    expect(reaisParaCentavos(null)).toBe(null);
    expect(reaisParaCentavos("-50")).toBe(null);
  });
});

describe("lerDuracao", () => {
  it("aceita minutos positivos", () => {
    expect(lerDuracao("90")).toBe(90);
    expect(lerDuracao(15)).toBe(15);
  });

  it("vazio ou inválido = herda o padrão da clínica", () => {
    expect(lerDuracao("")).toBe(null);
    expect(lerDuracao("abc")).toBe(null);
    expect(lerDuracao("0")).toBe(null);
    expect(lerDuracao("-30")).toBe(null);
  });
});
