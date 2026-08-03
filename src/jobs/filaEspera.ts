/**
 * Reoferta da fila de espera.
 *
 * O convite tem prazo: o horário fica segurado por alguns minutos para quem foi
 * avisado. Este job é quem fecha o ciclo — passado o prazo sem resposta, solta o
 * horário e chama o próximo da fila.
 *
 * Sem ele a fila morria no primeiro convidado: quem não respondia virava
 * NOTIFIED e ficava assim para sempre, ninguém mais era avisado, e o horário
 * voltava ao balcão sem que a fila soubesse. O status DONE existia no schema
 * desde o começo e nunca era atribuído a ninguém.
 */
import { prisma } from "../db/client.js";
import { expirarOfertasFilaEspera } from "../domain/scheduling.js";
import { logger } from "../shared/logger.js";
import { dentroDaJanelaDeEnvio, getTenantConfig } from "./janela.js";

export async function reofertarFilaEspera(
  agora = new Date(),
): Promise<{ reofertados: number; encerrados: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let reofertados = 0;
  let encerrados = 0;

  for (const tenant of tenants) {
    const config = getTenantConfig(tenant);
    if (!config?.waitlist?.enabled) continue;

    // A reoferta MANDA MENSAGEM: vale a mesma janela dos outros jobs, senão o
    // próximo da fila é convidado às três da manhã.
    if (!dentroDaJanelaDeEnvio(tenant.timezone, agora)) continue;

    try {
      const r = await expirarOfertasFilaEspera(
        {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          timezone: tenant.timezone,
          whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
          config,
        },
        agora,
      );
      reofertados += r.reofertados;
      encerrados += r.encerrados;
    } catch (err) {
      logger.error({ err, tenant: tenant.slug }, "falha ao reprocessar a fila de espera");
    }
  }

  return { reofertados, encerrados };
}
