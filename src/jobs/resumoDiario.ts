/**
 * Resumo diário para quem assina o cheque.
 *
 * O dono da clínica raramente entra no painel. O produto some da vista dele e,
 * na hora de renovar, ele avalia algo de que não lembra. Uma mensagem por dia
 * com a agenda de hoje, as faltas de ontem e os horários vagos mantém o valor
 * visível — e é exatamente a informação que ele pediria à recepção.
 *
 * Exige TEMPLATE aprovado, ao contrário do follow-up e do desfecho: aqui a
 * janela de 24h da Meta nunca está aberta, porque o dono não escreve para o bot.
 */
import { DateTime } from "luxon";
import { prisma } from "../db/client.js";
import { sendWhatsAppTemplate } from "../channels/whatsapp/client.js";
import { AppointmentStatus } from "../shared/enums.js";
import { logger } from "../shared/logger.js";
import { mascararTelefone } from "../shared/pii.js";
import { getTenantConfig } from "./janela.js";

/** Hora do envio quando a clínica não configurou. */
export const HORA_PADRAO = 8;

/**
 * Já está na hora de mandar o resumo de hoje?
 *
 * Regra pura (testável). Duas condições: estamos na hora configurada (no fuso
 * da clínica) e ainda não saiu resumo HOJE. A segunda é o que impede um resumo
 * a cada ciclo de 10 minutos enquanto durar a hora marcada.
 */
export function deveEnviarResumo(
  agora: Date,
  timezone: string,
  hora: number,
  ultimoEnvio: Date | null,
): boolean {
  const local = DateTime.fromJSDate(agora).setZone(timezone);
  if (local.hour !== hora) return false;
  if (!ultimoEnvio) return true;

  const ultimo = DateTime.fromJSDate(ultimoEnvio).setZone(timezone);
  return !ultimo.hasSame(local, "day");
}

export interface ResumoDoDia {
  consultasHoje: number;
  confirmadasHoje: number;
  horariosLivresHoje: number;
  faltasOntem: number;
}

/** Os números do dia, no fuso da clínica. */
export async function apurarResumo(
  tenantId: string,
  timezone: string,
  agora: Date,
): Promise<ResumoDoDia> {
  const hoje = DateTime.fromJSDate(agora).setZone(timezone).startOf("day");
  const amanha = hoje.plus({ days: 1 });
  const ontem = hoje.minus({ days: 1 });

  const janelaHoje = { gte: hoje.toJSDate(), lt: amanha.toJSDate() };

  const [consultasHoje, confirmadasHoje, horariosLivresHoje, faltasOntem] = await Promise.all([
    prisma.appointment.count({
      where: {
        tenantId,
        status: { not: AppointmentStatus.CANCELLED },
        slot: { startsAt: janelaHoje },
      },
    }),
    prisma.appointment.count({
      where: { tenantId, status: AppointmentStatus.CONFIRMED, slot: { startsAt: janelaHoje } },
    }),
    // Horário livre de hoje que já passou não é vaga para vender: conta só
    // daqui para a frente.
    prisma.slot.count({
      where: {
        tenantId,
        status: "AVAILABLE",
        startsAt: { gte: agora, lt: amanha.toJSDate() },
      },
    }),
    prisma.appointment.count({
      where: {
        tenantId,
        status: AppointmentStatus.NO_SHOW,
        slot: { startsAt: { gte: ontem.toJSDate(), lt: hoje.toJSDate() } },
      },
    }),
  ]);

  return { consultasHoje, confirmadasHoje, horariosLivresHoje, faltasOntem };
}

/** Envia o resumo diário de todas as clínicas com o recurso ligado. */
export async function enviarResumosDiarios(
  agora = new Date(),
): Promise<{ enviados: number; falhas: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let enviados = 0;
  let falhas = 0;

  for (const tenant of tenants) {
    const config = getTenantConfig(tenant);
    const cfg = config?.dailyDigest;
    if (!cfg?.enabled || !cfg.phone || !cfg.templateName) continue;

    const hora = Number.isFinite(cfg.hora) ? (cfg.hora as number) : HORA_PADRAO;
    if (!deveEnviarResumo(agora, tenant.timezone, hora, tenant.lastDigestAt)) continue;

    try {
      const r = await apurarResumo(tenant.id, tenant.timezone, agora);
      const data = DateTime.fromJSDate(agora).setZone(tenant.timezone).toFormat("dd/MM");

      await sendWhatsAppTemplate(tenant.whatsappPhoneNumberId, cfg.phone, {
        name: cfg.templateName,
        lang: cfg.templateLang || "pt_BR",
        // {{1}} data · {{2}} consultas · {{3}} confirmadas · {{4}} vagas · {{5}} faltas ontem
        bodyParams: [
          data,
          String(r.consultasHoje),
          String(r.confirmadasHoje),
          String(r.horariosLivresHoje),
          String(r.faltasOntem),
        ],
      });

      // A marca vai DEPOIS do envio: se o processo cair no meio, o pior caso é
      // um resumo repetido — nunca um dia sem resumo por causa de uma marca
      // gravada sem que a mensagem tenha saído.
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { lastDigestAt: new Date() },
      });
      enviados++;
    } catch (err) {
      falhas++;
      logger.error(
        { err, tenant: tenant.slug, to: mascararTelefone(cfg.phone) },
        "falha ao enviar o resumo diário",
      );
    }
  }

  if (enviados || falhas) logger.info({ enviados, falhas }, "resumos diários processados");
  return { enviados, falhas };
}
