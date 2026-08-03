/**
 * Agenda rolante.
 *
 * Os horários são gerados para uma janela fixa de dias. Sem isso, a agenda
 * "vence": passada a janela, o bot não teria mais o que oferecer. Este job
 * regenera diariamente a janela de `booking.advanceBookingDays` de cada clínica.
 *
 * `regenerateSlots` só apaga horários LIVRES e sem agendamento — os reservados
 * ficam intactos e o horário de uma consulta ativa não é reaberto.
 */
import { prisma } from "../db/client.js";
import { regenerateSlots } from "../db/seed.js";
import { sincronizarFeriados } from "./feriados.js";
import { logger } from "../shared/logger.js";
import type { TenantConfig } from "../config/types.js";

export async function renovarAgendas(): Promise<{ clinicas: number; horarios: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let clinicas = 0;
  let horarios = 0;

  for (const tenant of tenants) {
    let config: TenantConfig;
    try {
      config = JSON.parse(tenant.config) as TenantConfig;
    } catch {
      continue;
    }

    // Os feriados viram bloqueios ANTES da geração — criados depois, só valeriam
    // na renovação do dia seguinte, e o agente passaria hoje inteiro oferecendo
    // horários num dia em que a clínica fecha.
    try {
      await sincronizarFeriados(tenant, config);
    } catch (err) {
      logger.error({ err, tenant: tenant.slug }, "falha ao sincronizar os feriados");
    }

    try {
      const n = await regenerateSlots(prisma, {
        tenantId: tenant.id,
        timezone: tenant.timezone,
        config,
        slotDays: config.booking.advanceBookingDays || 30,
      });
      clinicas++;
      horarios += n;
    } catch (err) {
      logger.error({ err, tenant: tenant.slug }, "falha ao renovar a agenda");
    }
  }

  if (clinicas) logger.info({ clinicas, horarios }, "agendas renovadas");
  return { clinicas, horarios };
}
