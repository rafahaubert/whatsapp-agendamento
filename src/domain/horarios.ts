/**
 * Regras de HORÁRIO — puras (só luxon), sem Prisma e sem IA.
 *
 * Ficam aqui para poderem ser usadas ao mesmo tempo pelo gerador da agenda
 * (src/db/seed.ts), pela busca de horários (src/domain/scheduling.ts) e pelo
 * system prompt (src/ai/systemPrompt.ts) — este último não pode importar nada
 * que arraste o banco junto.
 */
import { DateTime } from "luxon";
import type { DiaAtendimento } from "../config/types.js";
import { formatarDia } from "../shared/datetime.js";

// =========================================================
// Períodos do dia
// =========================================================
export type Periodo = "manha" | "tarde" | "noite";

/** Faixas de hora local (início inclusivo, fim exclusivo) de cada período. */
export const PERIODOS: Record<Periodo, [number, number]> = {
  manha: [0, 12],
  tarde: [12, 18],
  noite: [18, 24],
};

export const ORDEM_PERIODOS: Periodo[] = ["manha", "tarde", "noite"];

const ROTULO_PERIODO: Record<Periodo, string> = {
  manha: "manhã",
  tarde: "tarde",
  noite: "noite",
};

/** Faixa de um período informado pelo modelo (tolerante a caixa/espaços). */
export function faixaDoPeriodo(periodo?: string | null): [number, number] | undefined {
  if (!periodo) return undefined;
  const chave = normalizar(periodo);
  return PERIODOS[chave as Periodo];
}

/** "manhã ou tarde" · "manhã, tarde ou noite" — para o texto da pergunta. */
export function rotularPeriodos(periodos: Periodo[]): string {
  const nomes = periodos.map((p) => ROTULO_PERIODO[p]);
  if (nomes.length === 0) return "";
  if (nomes.length === 1) return nomes[0];
  return `${nomes.slice(0, -1).join(", ")} ou ${nomes[nomes.length - 1]}`;
}

// =========================================================
// Faixas de atendimento de um dia
// =========================================================
const DIAS_ABREV = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** 1=seg … 7=dom (convenção do luxon) → nome por extenso. */
const NOME_SEMANA: Record<number, string> = {
  1: "segunda-feira",
  2: "terça-feira",
  3: "quarta-feira",
  4: "quinta-feira",
  5: "sexta-feira",
  6: "sábado",
  7: "domingo",
};

/** "HH:MM" → minutos desde a meia-noite. */
export function minutosDoDia(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Minutos desde a meia-noite → "HH:MM". */
export function paraHHMM(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * O slot cai no intervalo (almoço)? Considera sobreposição, não só o início —
 * um slot 11:45–12:15 com almoço 12:00–13:00 também é descartado.
 */
export function noIntervalo(
  inicioMin: number,
  fimMin: number,
  dia: { breakStart?: string; breakEnd?: string },
): boolean {
  if (!dia.breakStart || !dia.breakEnd) return false;
  const bs = minutosDoDia(dia.breakStart);
  const be = minutosDoDia(dia.breakEnd);
  if (be <= bs) return false; // intervalo inválido: ignora
  return inicioMin < be && fimMin > bs;
}

/**
 * Minutos em que cada slot COMEÇA num dia de atendimento. Espelha o laço do
 * gerador (src/db/seed.ts) para que "último horário do dia" seja exatamente o
 * que existe na agenda.
 */
export function iniciosDoDia(dia: DiaAtendimento, duracaoMinutos: number): number[] {
  const duracao = Math.max(1, Math.trunc(duracaoMinutos) || 1);
  const abre = minutosDoDia(dia.open);
  const fecha = minutosDoDia(dia.close);
  const inicios: number[] = [];
  for (let m = abre; m < fecha; m += duracao) {
    if (!noIntervalo(m, m + duracao, dia)) inicios.push(m);
  }
  return inicios;
}

/** Agrupa dias com a mesma característica: "seg, ter: 08:00 às 18:00 · sáb: …". */
function agruparPorDia(valorDoDia: (d: number) => string | null, vazio: string): string {
  const grupos = new Map<string, number[]>();
  for (let d = 0; d < 7; d++) {
    const v = valorDoDia(d);
    if (v === null) continue;
    if (!grupos.has(v)) grupos.set(v, []);
    grupos.get(v)!.push(d);
  }
  if (grupos.size === 0) return vazio;
  return [...grupos.entries()]
    .map(([v, dias]) => `${dias.map((d) => DIAS_ABREV[d]).join(", ")}: ${v}`)
    .join(" · ");
}

/** "seg, ter, qua: 08:30 às 22:30 · sáb: 08:00 às 12:00" */
export function resumoAgenda(days: Record<number, { open: string; close: string } | null>): string {
  return agruparPorDia((d) => {
    const h = days[d];
    return h ? `${h.open} às ${h.close}` : null;
  }, "sem dias de atendimento definidos");
}

export interface JanelaAtendimento {
  /** "seg, ter, qua, qui, sex: 08:00 às 18:00 · sáb: 08:00 às 12:00" */
  resumo: string;
  /** Períodos que realmente têm horário na agenda. */
  periodos: Periodo[];
  /** "seg, ter, qua, qui, sex: 17:30 · sáb: 11:30" */
  ultimoPorDia: string;
  /** Há pelo menos um horário na semana? */
  temAlgum: boolean;
}

/**
 * O que a agenda da clínica REALMENTE oferece. Usado pelo system prompt para o
 * agente não perguntar por um período que não existe (ex.: "noite" numa clínica
 * que fecha às 18h) e para saber qual é o último horário de cada dia.
 */
export function janelaAtendimento(
  days: Record<number, DiaAtendimento | null>,
  duracaoMinutos: number,
): JanelaAtendimento {
  const periodos = new Set<Periodo>();
  const ultimoDoDia = new Map<number, string>();

  for (let d = 0; d < 7; d++) {
    const dia = days[d];
    if (!dia) continue;
    const inicios = iniciosDoDia(dia, duracaoMinutos);
    if (inicios.length === 0) continue;

    for (const minuto of inicios) {
      const hora = minuto / 60;
      for (const p of ORDEM_PERIODOS) {
        const [ini, fim] = PERIODOS[p];
        if (hora >= ini && hora < fim) periodos.add(p);
      }
    }
    ultimoDoDia.set(d, paraHHMM(inicios[inicios.length - 1]));
  }

  return {
    resumo: resumoAgenda(days),
    periodos: ORDEM_PERIODOS.filter((p) => periodos.has(p)),
    ultimoPorDia: agruparPorDia((d) => ultimoDoDia.get(d) ?? null, "sem horários gerados"),
    temAlgum: ultimoDoDia.size > 0,
  };
}

// =========================================================
// Interpretação do que o paciente pediu
// =========================================================
function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // remove acentos
}

/**
 * "16:30", "16h30", "16h", "16", 16 → minutos desde a meia-noite (990, 960…).
 * Aceita o inteiro antigo por compatibilidade. Devolve null se não entender.
 */
export function parseHoraPreferida(valor: string | number | null | undefined): number | null {
  if (valor === null || valor === undefined || valor === "") return null;

  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || valor < 0 || valor > 23) return null;
    return Math.trunc(valor) * 60;
  }

  const m = normalizar(valor).match(/^(\d{1,2})(?:\s*[:h.]\s*(\d{1,2}))?/);
  if (!m) return null;
  const hora = Number(m[1]);
  const minuto = m[2] ? Number(m[2]) : 0;
  if (hora > 23 || minuto > 59) return null;
  return hora * 60 + minuto;
}

/** Dia pedido pelo paciente: uma data específica ou um dia da semana. */
export type FiltroDia =
  | { tipo: "data"; ano: number; mes: number; dia: number }
  | { tipo: "semana"; weekday: number }; // 1=seg … 7=dom

const SEMANA: Record<string, number> = {
  segunda: 1, seg: 1,
  terca: 2, ter: 2,
  quarta: 3, qua: 3,
  quinta: 4, qui: 4,
  sexta: 5, sex: 5,
  sabado: 6, sab: 6,
  domingo: 7, dom: 7,
};

/**
 * "segunda", "seg", "amanhã", "27/07", "2026-07-27" → filtro de dia.
 * Devolve null quando não dá para entender (aí a busca não filtra por dia).
 */
export function resolverDia(
  dia: string | null | undefined,
  timezone: string,
  agora: Date,
): FiltroDia | null {
  if (!dia) return null;
  const texto = normalizar(dia);
  if (!texto) return null;

  const hoje = DateTime.fromJSDate(agora).setZone(timezone).startOf("day");
  const comoData = (d: DateTime): FiltroDia => ({
    tipo: "data",
    ano: d.year,
    mes: d.month,
    dia: d.day,
  });

  // Relativos — "depois de amanhã" antes de "amanhã" (um contém o outro).
  if (/depois de amanha/.test(texto)) return comoData(hoje.plus({ days: 2 }));
  if (/\bamanha\b/.test(texto)) return comoData(hoje.plus({ days: 1 }));
  if (/\bhoje\b/.test(texto)) return comoData(hoje);

  // ISO: 2026-07-27
  const iso = texto.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { tipo: "data", ano: Number(iso[1]), mes: Number(iso[2]), dia: Number(iso[3]) };

  // dd/mm[/aaaa] — sem ano, escolhe a próxima ocorrência.
  const br = texto.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/);
  if (br) {
    const d = Number(br[1]);
    const mes = Number(br[2]);
    if (d >= 1 && d <= 31 && mes >= 1 && mes <= 12) {
      if (br[3]) {
        const ano = Number(br[3]);
        return { tipo: "data", ano: ano < 100 ? 2000 + ano : ano, dia: d, mes };
      }
      const candidato = DateTime.fromObject({ year: hoje.year, month: mes, day: d }, { zone: timezone });
      const ano = candidato.isValid && candidato < hoje ? hoje.year + 1 : hoje.year;
      return { tipo: "data", ano, mes, dia: d };
    }
  }

  // Dia da semana ("segunda", "segunda-feira", "seg").
  for (const token of texto.split(/[^a-z0-9]+/)) {
    const weekday = SEMANA[token];
    if (weekday) return { tipo: "semana", weekday };
  }

  return null;
}

function casaComDia(momento: DateTime, filtro: FiltroDia): boolean {
  if (filtro.tipo === "data") {
    return momento.year === filtro.ano && momento.month === filtro.mes && momento.day === filtro.dia;
  }
  return momento.weekday === filtro.weekday;
}

function descreverFiltroDia(filtro: FiltroDia, timezone: string): string {
  if (filtro.tipo === "semana") return NOME_SEMANA[filtro.weekday] ?? "esse dia";
  const d = DateTime.fromObject(
    { year: filtro.ano, month: filtro.mes, day: filtro.dia },
    { zone: timezone },
  );
  return d.isValid ? formatarDia(d.toJSDate(), timezone) : "esse dia";
}

// =========================================================
// Escolha dos horários oferecidos
// =========================================================

/**
 * Um horário por faixa de tempo (regra pura, testável).
 *
 * Oferecer o mesmo horário com dois profissionais desperdiça as opções e
 * confunde o paciente. Quando há empate, mantemos o `profissionalHabitual`
 * (continuidade de tratamento); senão, o primeiro da ordem recebida.
 */
export function umPorHorario<T extends { startsAt: Date; doctorId: string }>(
  slots: T[],
  profissionalHabitual?: string | null,
): T[] {
  const porHorario = new Map<number, T>();
  for (const s of slots) {
    const chave = s.startsAt.getTime();
    const atual = porHorario.get(chave);
    const trocar =
      !atual ||
      (!!profissionalHabitual &&
        s.doctorId === profissionalHabitual &&
        atual.doctorId !== profissionalHabitual);
    if (trocar) porHorario.set(chave, s);
  }
  return [...porHorario.values()];
}

export interface OpcoesEscolha {
  timezone: string;
  /** Quantas opções oferecer (booking.maxOptionsOffered). */
  max: number;
  agora: Date;
  periodo?: string | null;
  /** Dia pedido pelo paciente ("segunda", "amanhã", "27/07"). */
  dia?: string | null;
  /** Horário pedido ("16:30", "16h30", 16). */
  horaPreferida?: string | number | null;
  profissionalHabitual?: string | null;
}

export interface ResultadoEscolha<T> {
  escolhidos: T[];
  /** null = o paciente não pediu horário específico. */
  exato: boolean | null;
  /** Dia a que as opções se referem ("seg., 27/07"). */
  diaConsiderado: string | null;
  aviso?: string;
}

/**
 * Escolhe quais horários oferecer.
 *
 * A regra que importa: quando o paciente pede um horário ("16h30"), as opções
 * saem do MESMO DIA, em volta do horário pedido — e não do mesmo horário em
 * três dias diferentes, que era o comportamento anterior e fazia o agente
 * afirmar que um horário existente não existia.
 */
export function escolherHorarios<T extends { startsAt: Date; doctorId: string }>(
  slots: T[],
  opts: OpcoesEscolha,
): ResultadoEscolha<T> {
  const { timezone, max, agora } = opts;
  const local = (d: Date) => DateTime.fromJSDate(d).setZone(timezone);
  const minutosLocais = (d: Date) => {
    const dt = local(d);
    return dt.hour * 60 + dt.minute;
  };
  const dataDe = (d: Date) => local(d).toISODate() ?? "";

  // 1) Período do dia.
  const faixa = faixaDoPeriodo(opts.periodo);
  let candidatos = faixa
    ? slots.filter((s) => {
        const hora = minutosLocais(s.startsAt) / 60;
        return hora >= faixa[0] && hora < faixa[1];
      })
    : [...slots];

  const nadaEncontrado = (aviso: string): ResultadoEscolha<T> => ({
    escolhidos: [],
    exato: null,
    diaConsiderado: null,
    aviso,
  });

  if (candidatos.length === 0) {
    return nadaEncontrado(
      opts.periodo
        ? `Nenhum horário livre no período "${opts.periodo}". Ofereça outro período.`
        : "Nenhum horário livre encontrado com esses critérios.",
    );
  }

  // 2) Dia pedido: mantém só ele e, se for dia da semana, a primeira ocorrência.
  const filtro = resolverDia(opts.dia, timezone, agora);
  let diaAlvo: string | null = null;

  if (filtro) {
    const doDia = candidatos.filter((s) => casaComDia(local(s.startsAt), filtro));
    if (doDia.length === 0) {
      const periodoTxt = opts.periodo ? ` no período da ${opts.periodo}` : "";
      return nadaEncontrado(
        `Não há horário livre em ${descreverFiltroDia(filtro, timezone)}${periodoTxt}. Ofereça outro dia.`,
      );
    }
    candidatos = doDia;
    diaAlvo = candidatos.map((s) => dataDe(s.startsAt)).sort()[0];
  }

  // 3) Horário pedido sem dia: ancora no primeiro dia que tenha horário.
  const alvo = parseHoraPreferida(opts.horaPreferida);
  if (alvo !== null && !diaAlvo) {
    diaAlvo = candidatos.map((s) => dataDe(s.startsAt)).sort()[0] ?? null;
  }

  // 4) Ordenação: o dia escolhido primeiro; os demais só completam a lista.
  const porProximidade = (a: T, b: T) =>
    Math.abs(minutosLocais(a.startsAt) - (alvo as number)) -
      Math.abs(minutosLocais(b.startsAt) - (alvo as number)) ||
    a.startsAt.getTime() - b.startsAt.getTime();
  const cronologico = (a: T, b: T) => a.startsAt.getTime() - b.startsAt.getTime();
  const ordenar = alvo !== null ? porProximidade : cronologico;

  let ordenados: T[];
  if (diaAlvo) {
    const noDia = candidatos.filter((s) => dataDe(s.startsAt) === diaAlvo);
    const outrosDias = candidatos.filter((s) => dataDe(s.startsAt) !== diaAlvo);
    ordenados = [...noDia.sort(ordenar), ...outrosDias.sort(ordenar)];
  } else {
    ordenados = [...candidatos].sort(ordenar);
  }

  const escolhidos = umPorHorario(ordenados, opts.profissionalHabitual).slice(0, max);

  // 5) O horário pedido existe mesmo no dia escolhido?
  const exato =
    alvo === null
      ? null
      : candidatos.some(
          (s) => dataDe(s.startsAt) === diaAlvo && minutosLocais(s.startsAt) === alvo,
        );

  // Só afirma um dia quando as opções REALMENTE se referem a um: numa busca
  // sem dia nem horário elas podem cair em dias diferentes.
  const diaConsiderado =
    diaAlvo && escolhidos.length ? formatarDia(escolhidos[0].startsAt, timezone) : null;

  let aviso: string | undefined;
  if (exato === false) {
    aviso =
      `Não há horário livre exatamente às ${paraHHMM(alvo as number)}` +
      `${diaConsiderado ? ` em ${diaConsiderado}` : ""}. ` +
      "Diga isso ao paciente e ofereça as opções abaixo, que são as mais próximas.";
  }

  return { escolhidos, exato, diaConsiderado, aviso };
}
