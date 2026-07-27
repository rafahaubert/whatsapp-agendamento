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

/** Só o dia, no fuso da clínica. Ex.: "seg., 28/07". */
export function formatarDia(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}
