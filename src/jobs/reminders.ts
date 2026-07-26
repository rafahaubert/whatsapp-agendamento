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
import type { TenantConfig } from "../config/types.js";

/** Status que ainda merecem lembrete (cancelado/faltou não recebem). */
const ELEGIVEIS: string[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.RESCHEDULED,
];

export interface AgendamentoLembrete {
  id: string;
  status: string;
  reminderSentAt: Date | null;
  startsAt: Date;
}

/**
 * Regra pura (testável): quais agendamentos devem receber lembrete agora.
 * Elegível = status ativo, ainda sem lembrete e começando dentro da janela
 * [agora, agora + hoursBefore].
 */
export function selecionarParaLembrete<T extends AgendamentoLembrete>(
  agendamentos: T[],
  agora: Date,
  hoursBefore: number,
): T[] {
  const limite = new Date(agora.getTime() + hoursBefore * 3_600_000);
  return agendamentos.filter(
    (a) =>
      a.reminderSentAt == null &&
      ELEGIVEIS.includes(a.status) &&
      a.startsAt > agora &&
      a.startsAt <= limite,
  );
}

/** Executa os lembretes de todas as clínicas com o recurso ligado. */
export async function enviarLembretes(agora = new Date()): Promise<{ enviados: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let enviados = 0;

  for (const tenant of tenants) {
    let config: TenantConfig;
    try {
      config = JSON.parse(tenant.config) as TenantConfig;
    } catch {
      continue;
    }

    const cfg = config.reminders;
    if (!cfg?.enabled || !cfg.templateName) continue;

    const limite = new Date(agora.getTime() + cfg.hoursBefore * 3_600_000);
    const candidatos = await prisma.appointment.findMany({
      where: {
        tenantId: tenant.id,
        reminderSentAt: null,
        status: { in: ELEGIVEIS },
        slot: { startsAt: { gt: agora, lte: limite } },
      },
      include: { patient: true, doctor: true, unit: true, specialty: true, slot: true },
      take: 200,
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
          data: { reminderSentAt: new Date() },
        });
        enviados++;
      } catch (err) {
        logger.error({ err, appointmentId: appt.id }, "falha ao enviar lembrete");
      }
    }
  }

  if (enviados) logger.info({ enviados }, "lembretes enviados");
  return { enviados };
}
