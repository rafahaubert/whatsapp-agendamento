/**
 * Google Agenda → sistema: a metade que faltava da integração.
 *
 * Até aqui o sistema só ESCREVIA no Google. O `SECURITY.md` registrava a falha
 * com todas as letras: bloqueio feito direto lá não era visto, e o agente
 * continuava oferecendo aquele horário. O dentista marcava um congresso pelo
 * celular e, na terça, o paciente aparecia para uma sala vazia.
 *
 * O caminho de volta traduz os períodos ocupados da agenda do profissional em
 * linhas de `blocks` — a mesma tabela que férias e feriados já usam. O gerador
 * de horários então respeita o compromisso sem saber que ele veio do Google.
 *
 * NÃO é sincronização bidirecional completa: não há canais de notificação
 * (`watch`), então a leitura é por varredura, e a granularidade é a do cron. Um
 * bloqueio criado no Google leva até um ciclo para fechar a agenda aqui. Fecha
 * o buraco que existia; não promete tempo real.
 */
import { prisma } from "../db/client.js";
import { isGoogleConfigured, listBusyIntervals } from "../integrations/googleCalendar.js";
import { logger } from "../shared/logger.js";
import type { TenantConfig } from "../config/types.js";

/**
 * Prefixo que marca o bloqueio como criado por esta sincronização.
 *
 * Mesma disciplina dos feriados: é por ele que a reconciliação sabe o que pode
 * mexer. Férias escritas pela recepção nunca são tocadas, e apagar o
 * compromisso no Google devolve o horário à agenda.
 */
export const PREFIXO_GOOGLE = "Google Agenda";

/** Chave de comparação de um bloqueio: profissional + intervalo exato. */
function chaveBloqueio(doctorId: string, startsAt: Date, endsAt: Date): string {
  return `${doctorId}|${startsAt.getTime()}|${endsAt.getTime()}`;
}

/**
 * Sincroniza a agenda de UM profissional.
 *
 * `eventosNossos` são os ids dos eventos que este sistema criou no calendário.
 * Sem excluí-los, cada consulta que agendamos viraria também um bloqueio, e a
 * agenda se fecharia progressivamente sozinha — pior ainda depois de um
 * cancelamento, porque o bloqueio sobreviveria ao evento apagado.
 */
export async function sincronizarAgendaDoProfissional(
  tenantId: string,
  doctorId: string,
  calendarId: string,
  dias: number,
  eventosNossos: Set<string>,
  agora = new Date(),
): Promise<{ criados: number; removidos: number }> {
  const ate = new Date(agora.getTime() + dias * 86_400_000);

  const ocupados = (await listBusyIntervals(calendarId, agora, ate)).filter(
    (o) => !eventosNossos.has(o.eventId),
  );

  const existentes = await prisma.block.findMany({
    where: {
      tenantId,
      doctorId,
      reason: { startsWith: PREFIXO_GOOGLE },
      endsAt: { gte: agora },
    },
  });

  const jaTem = new Map(
    existentes.map((b) => [chaveBloqueio(b.doctorId!, b.startsAt, b.endsAt), b]),
  );
  const manter = new Set<string>();
  let criados = 0;

  for (const o of ocupados) {
    const k = chaveBloqueio(doctorId, o.startsAt, o.endsAt);
    manter.add(k);
    if (jaTem.has(k)) continue;

    await prisma.block.create({
      data: {
        tenantId,
        doctorId,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        // O título do evento não entra: é a agenda pessoal do profissional, e
        // este sistema não tem por que guardá-la.
        reason: `${PREFIXO_GOOGLE} (compromisso externo)`,
      },
    });
    criados++;
  }

  // O compromisso apagado (ou movido) no Google tem de devolver o horário à
  // agenda; sem esta ponta, o bloqueio ficaria de pé para sempre.
  const sobrando = existentes
    .filter((b) => !manter.has(chaveBloqueio(b.doctorId!, b.startsAt, b.endsAt)))
    .map((b) => b.id);
  if (sobrando.length) {
    await prisma.block.deleteMany({ where: { id: { in: sobrando } } });
  }

  return { criados, removidos: sobrando.length };
}

/** Sincroniza todas as clínicas com o recurso ligado. */
export async function sincronizarGoogle(
  agora = new Date(),
): Promise<{ criados: number; removidos: number }> {
  if (!isGoogleConfigured()) return { criados: 0, removidos: 0 };

  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let criados = 0;
  let removidos = 0;

  for (const tenant of tenants) {
    let config: TenantConfig;
    try {
      config = JSON.parse(tenant.config) as TenantConfig;
    } catch {
      continue;
    }
    if (!config.booking.googleSync?.enabled) continue;

    const dias = config.booking.advanceBookingDays || 30;
    const doctors = await prisma.doctor.findMany({
      where: { tenantId: tenant.id, isActive: true, googleCalendarId: { not: null } },
      select: { id: true, name: true, googleCalendarId: true },
    });

    for (const doctor of doctors) {
      try {
        // Os eventos que NÓS escrevemos naquele calendário.
        const nossos = await prisma.appointment.findMany({
          where: {
            tenantId: tenant.id,
            doctorId: doctor.id,
            googleEventId: { not: null },
            slot: { endsAt: { gte: agora } },
          },
          select: { googleEventId: true },
        });

        const r = await sincronizarAgendaDoProfissional(
          tenant.id,
          doctor.id,
          doctor.googleCalendarId!,
          dias,
          new Set(nossos.map((a) => a.googleEventId!)),
          agora,
        );
        criados += r.criados;
        removidos += r.removidos;
      } catch (err) {
        logger.error(
          { err, tenant: tenant.slug, profissional: doctor.name },
          "falha ao ler a agenda do Google",
        );
      }
    }
  }

  if (criados || removidos) {
    logger.info({ criados, removidos }, "agendas do Google sincronizadas");
  }
  return { criados, removidos };
}
