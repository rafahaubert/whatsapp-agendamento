/**
 * Agenda rolante.
 *
 * Os horários são gerados para uma janela fixa de dias. Sem isso a agenda
 * "vence": passada a janela, o bot não teria mais o que oferecer. Este job
 * empurra a janela de `booking.advanceBookingDays` de cada clínica para a
 * frente, sozinho — ninguém precisa clicar em "gerar horários".
 *
 * `regenerateSlots` só apaga horários LIVRES e sem agendamento — os reservados
 * ficam intactos e o horário de uma consulta ativa não é reaberto.
 */
import { prisma } from "../db/client.js";
import { regenerateSlots } from "../db/seed.js";
import { SlotStatus } from "../shared/enums.js";
import { logger } from "../shared/logger.js";
import type { TenantConfig } from "../config/types.js";

/**
 * A partir de quando um horário livre prova que a agenda alcança o fim da janela.
 *
 * Reconstruir tudo a cada boot é desperdício — e o processo reinicia muitas
 * vezes por dia num plano que hiberna. A folga de um dia faz o teste falhar
 * sozinho quando a janela anda: como ela recua um dia por dia, a reconstrução
 * acontece naturalmente uma vez ao dia, sem precisar guardar "quando foi a
 * última vez". Mudanças de configuração não dependem disto — elas refazem a
 * agenda na hora (ver src/admin/router.ts).
 *
 * `null` = janela curta demais para o atalho valer; renove sempre.
 */
export function pontaDaJanela(janelaDias: number, agora: Date): Date | null {
  if (janelaDias <= 1) return null;
  return new Date(agora.getTime() + (janelaDias - 1) * 86_400_000);
}

async function agendaAlcancaAJanela(tenantId: string, janelaDias: number): Promise<boolean> {
  const alvo = pontaDaJanela(janelaDias, new Date());
  if (!alvo) return false;
  const naPonta = await prisma.slot.findFirst({
    where: { tenantId, status: SlotStatus.AVAILABLE, startsAt: { gte: alvo } },
    select: { id: true },
  });
  return Boolean(naPonta);
}

export async function renovarAgendas(
  opts: { forcar?: boolean } = {},
): Promise<{ clinicas: number; horarios: number; emDia: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let clinicas = 0;
  let horarios = 0;
  let emDia = 0;

  for (const tenant of tenants) {
    let config: TenantConfig;
    try {
      config = JSON.parse(tenant.config) as TenantConfig;
    } catch {
      continue;
    }

    const slotDays = config.booking.advanceBookingDays || 30;

    try {
      if (!opts.forcar && (await agendaAlcancaAJanela(tenant.id, slotDays))) {
        emDia++;
        continue;
      }

      const n = await regenerateSlots(prisma, {
        tenantId: tenant.id,
        timezone: tenant.timezone,
        config,
        slotDays,
      });
      clinicas++;
      horarios += n;
    } catch (err) {
      logger.error({ err, tenant: tenant.slug }, "falha ao renovar a agenda");
    }
  }

  if (clinicas) logger.info({ clinicas, horarios, emDia }, "agendas renovadas");
  return { clinicas, horarios, emDia };
}
