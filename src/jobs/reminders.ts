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

/** Janela de envio: só envia lembretes entre 8h e 20h no fuso da clínica. */
const HORA_INICIO_ENVIO = 8;
const HORA_FIM_ENVIO = 20;

/** Cache de configuração por tenant (evita reparsear JSON a cada execução). */
const configCache = new Map<string, { config: TenantConfig; ts: number }>();
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

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

/** Verifica se o horário atual está dentro da janela de envio da clínica. */
function dentroDaJanelaDeEnvio(timezone: string, agora: Date): boolean {
  const hora = parseInt(
    agora.toLocaleString("pt-BR", { timeZone: timezone, hour: "numeric", hour12: false }),
    10,
  );
  return hora >= HORA_INICIO_ENVIO && hora < HORA_FIM_ENVIO;
}

/** Obtém config do tenant com cache em memória. */
function getTenantConfig(tenant: { id: string; config: string }): TenantConfig | null {
  const cached = configCache.get(tenant.id);
  const now = Date.now();
  if (cached && now - cached.ts < CONFIG_CACHE_TTL_MS) {
    return cached.config;
  }
  try {
    const parsed = JSON.parse(tenant.config) as TenantConfig;
    configCache.set(tenant.id, { config: parsed, ts: now });
    return parsed;
  } catch {
    return null;
  }
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
          // Só tenta enviar lembretes que falharam até 3 vezes.
          // NOTA: adicione `reminderRetryCount Int @default(0)` ao schema do Appointment.
          // reminderRetryCount: { lt: 3 },
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
              // Limpar contador de retry no sucesso:
              // reminderRetryCount: 0,
              // reminderLastError: null,
            },
          });
          enviados++;
        } catch (err) {
          falhas++;
          logger.error({ err, appointmentId: appt.id }, "falha ao enviar lembrete");

          // Incrementar retry e registrar erro:
          // NOTA: requer campos `reminderRetryCount` e `reminderLastError` no schema.
          // await prisma.appointment.update({
          //   where: { id: appt.id },
          //   data: {
          //     reminderRetryCount: { increment: 1 },
          //     reminderLastError: String(err),
          //   },
          // });

          // Alertar admin após 2 falhas consecutivas:
          // if ((appt as any).reminderRetryCount >= 2) {
          //   await notificarAdmin(tenant.id, `Falha persistente no lembrete do paciente ${appt.patient.name}`);
          // }
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
