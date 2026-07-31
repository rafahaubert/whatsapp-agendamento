import { DateTime } from "luxon";
import { textoAparado } from "./texto.js";

/**
 * Data/hora digitada no painel (`<input type="datetime-local">`, que manda
 * "2026-07-31T14:00" — sem fuso), lida no fuso da CLÍNICA.
 *
 * `new Date("2026-07-31T14:00")` usa o fuso do SERVIDOR, e o container de
 * produção roda em UTC: uma consulta ou um bloqueio digitados às 14:00 viravam
 * 14:00Z, ou seja, 11:00 para uma clínica em São Paulo. Três horas a menos em
 * tudo que passa por formulário.
 *
 * Strings que já trazem fuso (o `toISOString()` que o calendário envia ao
 * arrastar um agendamento) continuam valendo pelo instante que carregam — o
 * luxon usa o offset da própria string quando ele existe.
 */
export function parseDataHoraLocal(valor: unknown, timeZone: string): Date | null {
  const bruto = textoAparado(valor);
  if (!bruto) return null;
  const dt = DateTime.fromISO(bruto, { zone: timeZone });
  return dt.isValid ? dt.toJSDate() : null;
}

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
