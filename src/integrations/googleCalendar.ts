/**
 * Integração one-way com o Google Calendar via CONTA DE SERVIÇO.
 *
 * A chave JSON da conta de serviço vem de GOOGLE_SERVICE_ACCOUNT_KEY. Cada
 * dentista compartilha o seu calendário com o e-mail da conta de serviço e
 * informa o Calendar ID no painel. Se a chave não estiver configurada, todas
 * as funções viram no-op (o sistema funciona sem Google).
 */
import { auth, calendar, type calendar_v3 } from "@googleapis/calendar";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";

interface ServiceKey {
  client_email: string;
  private_key: string;
}

let cached: ServiceKey | null | undefined;

function serviceKey(): ServiceKey | null {
  if (cached !== undefined) return cached;
  const raw = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    cached = null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceKey>;
    cached = parsed.client_email && parsed.private_key ? (parsed as ServiceKey) : null;
    if (!cached) logger.error("GOOGLE_SERVICE_ACCOUNT_KEY sem client_email/private_key");
  } catch {
    logger.error("GOOGLE_SERVICE_ACCOUNT_KEY inválido (não é JSON)");
    cached = null;
  }
  return cached;
}

export function isGoogleConfigured(): boolean {
  return serviceKey() !== null;
}

/** E-mail que o usuário deve compartilhar em cada calendário. */
export function serviceAccountEmail(): string | null {
  return serviceKey()?.client_email ?? null;
}

function client(): calendar_v3.Calendar | null {
  const k = serviceKey();
  if (!k) return null;
  const googleAuth = new auth.GoogleAuth({
    credentials: { client_email: k.client_email, private_key: k.private_key },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return calendar({ version: "v3", auth: googleAuth });
}

export interface EventData {
  summary: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
}

function body(ev: EventData): calendar_v3.Schema$Event {
  return {
    summary: ev.summary,
    description: ev.description,
    start: { dateTime: ev.startsAt.toISOString(), timeZone: ev.timeZone },
    end: { dateTime: ev.endsAt.toISOString(), timeZone: ev.timeZone },
  };
}

/** Cria o evento e devolve o eventId (ou null se não configurado). */
export async function createEvent(calendarId: string, ev: EventData): Promise<string | null> {
  const cal = client();
  if (!cal || !calendarId) return null;
  const res = await cal.events.insert({ calendarId, requestBody: body(ev) });
  return res.data.id ?? null;
}

export async function updateEvent(calendarId: string, eventId: string, ev: EventData): Promise<void> {
  const cal = client();
  if (!cal || !calendarId || !eventId) return;
  await cal.events.patch({ calendarId, eventId, requestBody: body(ev) });
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  const cal = client();
  if (!cal || !calendarId || !eventId) return;
  await cal.events.delete({ calendarId, eventId });
}

/** Um período ocupado lido da agenda do Google. */
export interface PeriodoOcupado {
  /** ID do evento no Google — usado para separar o que fomos NÓS que criamos. */
  eventId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Períodos ocupados de um calendário, entre duas datas.
 *
 * É a metade que faltava da integração: até aqui o sistema só ESCREVIA no
 * Google. Um bloqueio feito direto lá — o dentista marcando um congresso pelo
 * celular — não era visto, e o agente seguia oferecendo aquele horário. O
 * paciente aparecia; o dentista, não.
 *
 * Usa `events.list` em vez de `freebusy.query` por um motivo concreto: o
 * freebusy não devolve o id do evento, e sem ele não dá para distinguir a
 * agenda pessoal do dentista das consultas que NÓS mesmos escrevemos ali.
 * Tratar as nossas como bloqueio fecharia a agenda progressivamente.
 *
 * O `fields` é deliberadamente mínimo: título, descrição e convidados dos
 * eventos pessoais do dentista nunca chegam a trafegar.
 */
export async function listBusyIntervals(
  calendarId: string,
  de: Date,
  ate: Date,
): Promise<PeriodoOcupado[]> {
  const cal = client();
  if (!cal || !calendarId) return [];

  const ocupados: PeriodoOcupado[] = [];
  let pageToken: string | undefined;

  do {
    const res = await cal.events.list({
      calendarId,
      timeMin: de.toISOString(),
      timeMax: ate.toISOString(),
      // Expande recorrências: um "toda terça de manhã" vira ocorrências reais.
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
      pageToken,
      fields: "nextPageToken,items(id,start,end,status,transparency)",
    });

    for (const ev of res.data.items ?? []) {
      if (!ev.id || ev.status === "cancelled") continue;
      // "Disponível" no Google quer dizer exatamente isso: não ocupa a agenda.
      if (ev.transparency === "transparent") continue;

      // Evento de dia inteiro vem em `date`; com hora, em `dateTime`.
      const inicio = ev.start?.dateTime ?? ev.start?.date;
      const fim = ev.end?.dateTime ?? ev.end?.date;
      if (!inicio || !fim) continue;

      const startsAt = new Date(inicio);
      const endsAt = new Date(fim);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) continue;

      ocupados.push({ eventId: ev.id, startsAt, endsAt });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ocupados;
}
