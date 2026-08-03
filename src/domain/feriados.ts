/**
 * Feriados nacionais brasileiros.
 *
 * Sem isto, a clínica tinha de lembrar de bloquear o Carnaval na mão todo ano —
 * e quando esquecia, o agente passava a terça-feira inteira oferecendo horários
 * com a porta fechada. O paciente aparecia; ninguém estava lá.
 *
 * Só os feriados NACIONAIS entram: municipais e estaduais variam demais para
 * chutar, e continuam sendo bloqueio manual no painel (que já existe).
 *
 * Regras puras, sem banco: dá para testar a data de cada ano sem subir nada.
 */
import { DateTime } from "luxon";

export interface Feriado {
  /** "2026-02-17" no fuso da clínica. */
  data: string;
  nome: string;
  /**
   * Ponto facultativo na prática (Carnaval e Corpus Christi não são feriado
   * nacional por lei, mas quase toda clínica fecha). Fica marcado para a
   * clínica poder escolher.
   */
  facultativo: boolean;
}

/**
 * Domingo de Páscoa do ano, pelo algoritmo de Gauss/Butcher (calendário
 * gregoriano). É a âncora de Carnaval, Sexta-feira Santa e Corpus Christi.
 */
export function domingoDePascoa(ano: number): DateTime {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.fromObject({ year: ano, month: mes, day: dia }, { zone: "UTC" });
}

/** Feriados fixos: [mês, dia, nome]. */
const FIXOS: [number, number, string][] = [
  [1, 1, "Confraternização Universal"],
  [4, 21, "Tiradentes"],
  [5, 1, "Dia do Trabalho"],
  [9, 7, "Independência"],
  [10, 12, "Nossa Senhora Aparecida"],
  [11, 2, "Finados"],
  [11, 15, "Proclamação da República"],
  // Feriado nacional desde a Lei 14.759/2023.
  [11, 20, "Consciência Negra"],
  [12, 25, "Natal"],
];

/**
 * Todos os feriados nacionais do ano, ordenados por data.
 *
 * O ano é o do CALENDÁRIO, não o fiscal: a Páscoa move Carnaval e Corpus
 * Christi de lugar todo ano, e é por isso que eles não podem ser uma lista fixa.
 */
export function feriadosNacionais(ano: number): Feriado[] {
  const pascoa = domingoDePascoa(ano);

  const moveis: Feriado[] = [
    { data: pascoa.minus({ days: 48 }).toISODate()!, nome: "Carnaval (segunda)", facultativo: true },
    { data: pascoa.minus({ days: 47 }).toISODate()!, nome: "Carnaval (terça)", facultativo: true },
    { data: pascoa.minus({ days: 2 }).toISODate()!, nome: "Sexta-feira Santa", facultativo: false },
    { data: pascoa.plus({ days: 60 }).toISODate()!, nome: "Corpus Christi", facultativo: true },
  ];

  const fixos: Feriado[] = FIXOS.map(([mes, dia, nome]) => ({
    data: DateTime.fromObject({ year: ano, month: mes, day: dia }, { zone: "UTC" }).toISODate()!,
    nome,
    facultativo: false,
  }));

  return [...fixos, ...moveis].sort((a, b) => a.data.localeCompare(b.data));
}

/**
 * Feriados que caem dentro de uma janela de dias a partir de hoje.
 *
 * A janela costuma cruzar a virada do ano (gerar 60 dias em dezembro alcança
 * janeiro), por isso a busca varre o ano corrente E o seguinte.
 */
export function feriadosNaJanela(
  de: Date,
  dias: number,
  timezone: string,
  incluirFacultativos: boolean,
): Feriado[] {
  const inicio = DateTime.fromJSDate(de).setZone(timezone).startOf("day");
  const fim = inicio.plus({ days: dias });

  const anos = new Set([inicio.year, fim.year]);
  const todos = [...anos].flatMap((ano) => feriadosNacionais(ano));

  return todos
    .filter((f) => incluirFacultativos || !f.facultativo)
    .filter((f) => {
      const d = DateTime.fromISO(f.data, { zone: timezone });
      return d >= inicio && d < fim;
    })
    .sort((a, b) => a.data.localeCompare(b.data));
}

/** O dia inteiro do feriado, no fuso da clínica — o intervalo que vira `Block`. */
export function intervaloDoFeriado(
  feriado: Feriado,
  timezone: string,
): { startsAt: Date; endsAt: Date } {
  const inicio = DateTime.fromISO(feriado.data, { zone: timezone }).startOf("day");
  return { startsAt: inicio.toJSDate(), endsAt: inicio.endOf("day").toJSDate() };
}
