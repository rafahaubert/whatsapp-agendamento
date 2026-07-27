import { DateTime } from "luxon";

/** Formata uma data no fuso da clínica, em pt-BR. Ex.: "seg., 28/07, 14:30". */
export function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Só o dia, para falar de uma data inteira. Ex.: "qua., 29/07". */
export function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

/** Como o paciente escreve o dia da semana → índice (0=domingo … 6=sábado). */
const DIAS_SEMANA = new Map<string, number>([
  ["domingo", 0],
  ["dom", 0],
  ["segunda", 1],
  ["seg", 1],
  ["terca", 2],
  ["ter", 2],
  ["quarta", 3],
  ["qua", 3],
  ["quinta", 4],
  ["qui", 4],
  ["sexta", 5],
  ["sex", 5],
  ["sabado", 6],
  ["sab", 6],
]);

/** Palavras de ligação que o paciente usa antes do dia ("na quarta", "dia 29"). */
const PREFIXOS = /^(na|no|em|para|pra|de|do|da|dia|o|a)\s+/;

/** minúsculas, sem acento, sem "-feira" e sem preposições. "Na quarta-feira" → "quarta". */
function normalizar(texto: string): string {
  let s = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*-?\s*feira\s*$/, "")
    .trim();
  while (PREFIXOS.test(s)) s = s.replace(PREFIXOS, "");
  return s.trim();
}

/** Um dia inteiro no fuso da clínica: [inicio, fim). */
export interface JanelaDia {
  /** Meia-noite do dia, no fuso da clínica. */
  inicio: Date;
  /** Meia-noite do dia seguinte (exclusivo). */
  fim: Date;
  /** Rótulo em pt-BR do dia resolvido. Ex.: "qua., 29/07". */
  rotulo: string;
  /** Veio de um nome de dia da semana ("quarta"), não de uma data fixa. */
  diaDaSemana: boolean;
}

/**
 * Traduz o dia que o paciente pediu para a janela daquele dia, no fuso da clínica.
 *
 * Aceita nome do dia da semana ("quarta", "qua", "quarta-feira"), data
 * ("29/07", "29/07/2026", "2026-07-29"), dia do mês ("29") e os relativos
 * "hoje", "amanhã" e "depois de amanhã".
 *
 * Nome de dia da semana vira a PRÓXIMA ocorrência (hoje conta, se ainda houver
 * horário no dia). Data sem ano que já passou rola para o ano seguinte.
 * Devolve `null` quando não reconhece o texto.
 */
export function janelaDoDia(
  dia: string,
  timeZone: string,
  agora: Date = new Date(),
): JanelaDia | null {
  const s = normalizar(dia);
  if (!s) return null;

  const hoje = DateTime.fromJSDate(agora).setZone(timeZone).startOf("day");
  let alvo: DateTime | null = null;

  if (s === "hoje") alvo = hoje;
  else if (s === "amanha") alvo = hoje.plus({ days: 1 });
  else if (s === "depois de amanha") alvo = hoje.plus({ days: 2 });

  let porNome = false;
  const diaSemana = DIAS_SEMANA.get(s);
  if (!alvo && diaSemana !== undefined) {
    const atual = hoje.weekday === 7 ? 0 : hoje.weekday; // luxon: 1=seg … 7=dom
    alvo = hoje.plus({ days: (diaSemana - atual + 7) % 7 });
    porNome = true;
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!alvo && iso) {
    alvo = DateTime.fromObject(
      { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) },
      { zone: timeZone },
    );
  }

  const brasileira = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(s);
  if (!alvo && brasileira) {
    const ano = brasileira[3]
      ? Number(brasileira[3].length === 2 ? `20${brasileira[3]}` : brasileira[3])
      : hoje.year;
    let d = DateTime.fromObject(
      { year: ano, month: Number(brasileira[2]), day: Number(brasileira[1]) },
      { zone: timeZone },
    );
    // "29/07" pedido em dezembro é o ano que vem.
    if (!brasileira[3] && d.isValid && d < hoje) d = d.plus({ years: 1 });
    alvo = d;
  }

  const doMes = /^(\d{1,2})$/.exec(s);
  if (!alvo && doMes) {
    const n = Number(doMes[1]);
    let d = hoje.set({ day: n });
    if (!d.isValid || d < hoje) d = hoje.plus({ months: 1 }).set({ day: n });
    alvo = d;
  }

  if (!alvo?.isValid) return null;

  return {
    inicio: alvo.toJSDate(),
    fim: alvo.plus({ days: 1 }).toJSDate(),
    rotulo: formatDate(alvo.toJSDate(), timeZone),
    diaDaSemana: porNome,
  };
}
