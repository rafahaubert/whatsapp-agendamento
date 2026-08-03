/**
 * Lembrete automático de consulta — o recurso que mais reduz faltas.
 *
 * Envia um TEMPLATE aprovado na Meta X horas antes da consulta, com botões
 * Confirmar / Remarcar / Cancelar. É idempotente: grava `reminderSentAt` e
 * nunca reenvia para o mesmo agendamento.
 */
import { prisma } from "../db/client.js";
import { sendWhatsAppTemplate } from "../channels/whatsapp/client.js";
import { AppointmentStatus } from "../shared/enums.js";
import { formatDateTime } from "../shared/datetime.js";
import { logger } from "../shared/logger.js";
import { dentroDaJanelaDeEnvio, getTenantConfig } from "./janela.js";

/** Status que ainda merecem lembrete (cancelado/faltou não recebem). */
const ELEGIVEIS: string[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.RESCHEDULED,
];

/**
 * Tentativas de envio antes de desistir de um lembrete.
 *
 * Sem este corte o agendamento cujo envio falha nunca grava `reminderSentAt` e
 * volta à fila a cada ciclo do cron — para sempre. Com um template rejeitado
 * pela Meta isso vira chamada infinita à Graph API, gastando quota e enchendo o
 * log, sem que ninguém seja avisado.
 */
export const MAX_TENTATIVAS = 3;

/**
 * Carência padrão entre agendar e ser lembrado, quando a clínica não configurou.
 *
 * Seis horas cobrem o caso que mais incomodava — marcar de manhã para o dia
 * seguinte — sem atrasar o lembrete de quem marcou com dias de antecedência.
 */
export const MIN_HORAS_APOS_AGENDAR_PADRAO = 6;

export interface AgendamentoLembrete {
  id: string;
  status: string;
  reminderSentAt: Date | null;
  startsAt: Date;
  /** Quando o agendamento foi criado — base da carência. */
  createdAt: Date;
  /** Envios que já falharam para este agendamento. */
  reminderRetryCount: number;
}

/**
 * Regra pura (testável): quais agendamentos devem receber lembrete agora.
 *
 * Elegível = status ativo, ainda sem lembrete, com tentativas de sobra,
 * começando dentro da janela [agora, agora + hoursBefore] E agendado há tempo
 * suficiente para o lembrete não ser redundante (`minHorasAposAgendar`).
 */
export function selecionarParaLembrete<T extends AgendamentoLembrete>(
  agendamentos: T[],
  agora: Date,
  hoursBefore: number,
  minHorasAposAgendar: number = MIN_HORAS_APOS_AGENDAR_PADRAO,
): T[] {
  const limite = new Date(agora.getTime() + hoursBefore * 3_600_000);
  const criadoAteNoMaximo = new Date(agora.getTime() - minHorasAposAgendar * 3_600_000);
  return agendamentos.filter(
    (a) =>
      a.reminderSentAt == null &&
      a.reminderRetryCount < MAX_TENTATIVAS &&
      ELEGIVEIS.includes(a.status) &&
      a.startsAt > agora &&
      a.startsAt <= limite &&
      a.createdAt <= criadoAteNoMaximo,
  );
}

/** Executa os lembretes de todas as clínicas com o recurso ligado. */
export async function enviarLembretes(agora = new Date()): Promise<{ enviados: number; falhas: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let enviados = 0;
  let falhas = 0;

  for (const tenant of tenants) {
    const config = getTenantConfig(tenant);
    if (!config) continue;

    const cfg = config.reminders;
    if (!cfg?.enabled || !cfg.templateName) continue;

    // Só envia durante o horário de funcionamento da clínica.
    if (!dentroDaJanelaDeEnvio(tenant.timezone, agora)) {
      logger.debug({ tenant: tenant.slug }, "fora da janela de envio de lembretes");
      continue;
    }

    const limite = new Date(agora.getTime() + cfg.hoursBefore * 3_600_000);

    // Carência: lembrar alguém do que ele acabou de marcar gasta um template na
    // Meta para dizer o óbvio. O filtro vai na CONSULTA (e não só na regra pura)
    // para o agendamento recém-criado nem sequer ocupar uma página do cursor.
    const carencia =
      cfg.minHorasAposAgendar ?? MIN_HORAS_APOS_AGENDAR_PADRAO;
    const criadoAteNoMaximo = new Date(agora.getTime() - carencia * 3_600_000);

    // Paginação com cursor para não perder lembretes além de 200.
    let cursor: string | undefined;
    const pageSize = 200;

    do {
      const candidatos = await prisma.appointment.findMany({
        where: {
          tenantId: tenant.id,
          reminderSentAt: null,
          status: { in: ELEGIVEIS },
          slot: { startsAt: { gt: agora, lte: limite } },
          createdAt: { lte: criadoAteNoMaximo },
          // Quem já esgotou as tentativas sai da fila — sem isto o envio que
          // falha volta a cada ciclo do cron, indefinidamente.
          reminderRetryCount: { lt: MAX_TENTATIVAS },
        },
        include: { patient: true, doctor: true, unit: true, specialty: true, slot: true },
        take: pageSize,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { slot: { startsAt: "asc" } },
      });

      for (const appt of candidatos) {
        try {
          await sendWhatsAppTemplate(tenant.whatsappPhoneNumberId, appt.patient.phone, {
            name: cfg.templateName,
            lang: cfg.templateLang || "pt_BR",
            // {{1}} paciente · {{2}} data/hora · {{3}} profissional · {{4}} unidade
            bodyParams: [
              appt.patient.name,
              formatDateTime(appt.slot.startsAt, tenant.timezone),
              appt.doctor.name,
              appt.unit.name,
            ],
            buttonPayloads: [
              `CONFIRMAR:${appt.id}`,
              `REMARCAR:${appt.id}`,
              `CANCELAR:${appt.id}`,
            ],
          });

          await prisma.appointment.update({
            where: { id: appt.id },
            data: {
              reminderSentAt: new Date(),
              reminderRetryCount: 0,
              reminderLastError: null,
            },
          });
          enviados++;
        } catch (err) {
          falhas++;
          const tentativas = appt.reminderRetryCount + 1;
          logger.error(
            { err, appointmentId: appt.id, tentativas },
            "falha ao enviar lembrete",
          );

          // A tentativa gasta é registrada ANTES de qualquer outra coisa: é ela
          // que tira o agendamento da fila quando o erro é permanente.
          await prisma.appointment
            .update({
              where: { id: appt.id },
              data: {
                reminderRetryCount: { increment: 1 },
                // O erro da Meta traz o motivo (template rejeitado, número
                // inválido); cortado para não estourar a coluna com um HTML.
                reminderLastError: String(err).slice(0, 500),
              },
            })
            .catch((e) =>
              logger.error({ err: e, appointmentId: appt.id }, "falha ao registrar a tentativa"),
            );

          if (tentativas >= MAX_TENTATIVAS) {
            // Erro sistêmico (template rejeitado, token vencido) atinge a clínica
            // inteira, não um paciente. Fica em WARN próprio para dar gancho ao
            // alerta no painel, que ainda não existe.
            logger.warn(
              { tenant: tenant.slug, appointmentId: appt.id, tentativas },
              "lembrete desistido após esgotar as tentativas",
            );
          }
        }
      }

      cursor = candidatos.length === pageSize ? candidatos[candidatos.length - 1].id : undefined;
    } while (cursor);
  }

  if (enviados || falhas) {
    logger.info({ enviados, falhas }, "lembretes processados");
  }
  return { enviados, falhas };
}
