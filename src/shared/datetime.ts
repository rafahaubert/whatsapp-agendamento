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

/**
 * Dia e hora curtos, no fuso da clínica. Ex.: "27/07, 23:09".
 *
 * Usado no histórico da caixa de entrada: sem o fuso explícito o horário sai no
 * fuso do servidor (UTC em produção) e aparece 3h à frente do que o paciente vê
 * no WhatsApp.
 */
export function formatarHoraCurta(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
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
