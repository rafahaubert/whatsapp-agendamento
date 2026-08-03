/**
 * Fecha a agenda nos feriados nacionais.
 *
 * Traduz a lista de feriados (regra pura, src/domain/feriados.ts) em linhas de
 * `blocks` — a mesma tabela que a clínica já usa para férias e ausências. O
 * gerador de horários (`regenerateSlots`) então respeita o feriado sem saber que
 * ele é feriado: para ele é bloqueio como qualquer outro.
 *
 * Roda ANTES da renovação da agenda, senão o bloqueio criado hoje só valeria
 * amanhã.
 */
import { prisma } from "../db/client.js";
import { feriadosNaJanela, intervaloDoFeriado } from "../domain/feriados.js";
import { logger } from "../shared/logger.js";
import type { TenantConfig } from "../config/types.js";

/**
 * Prefixo que marca o bloqueio como criado por este job.
 *
 * É por ele que a reconciliação sabe o que pode mexer: um bloqueio escrito pela
 * recepção ("Dra. Ana de férias") nunca é tocado, e desligar o recurso remove só
 * o que este job criou.
 */
export const PREFIXO_FERIADO = "Feriado nacional: ";

/**
 * Sincroniza os feriados de UMA clínica dentro da janela de agendamento.
 *
 * Idempotente: roda todo dia sem duplicar. Reconcilia nos dois sentidos — cria o
 * que falta e remove o que não deve mais existir (a clínica desligou o recurso,
 * ou tirou os facultativos e o Carnaval precisa voltar a ser dia útil).
 */
export async function sincronizarFeriados(
  tenant: { id: string; slug: string; timezone: string },
  config: TenantConfig,
  agora = new Date(),
): Promise<{ criados: number; removidos: number }> {
  const cfg = config.booking.feriadosNacionais;
  const dias = config.booking.advanceBookingDays || 30;

  const desejados = cfg?.enabled
    ? feriadosNaJanela(agora, dias, tenant.timezone, cfg.incluirFacultativos)
    : [];

  // Só os bloqueios DESTE job, e só os que alcançam a janela — férias marcadas
  // pela recepção e feriados de anos passados ficam de fora.
  const existentes = await prisma.block.findMany({
    where: {
      tenantId: tenant.id,
      doctorId: null, // feriado fecha a clínica inteira
      reason: { startsWith: PREFIXO_FERIADO },
      endsAt: { gte: agora },
    },
  });

  const chave = (inicio: Date) => inicio.toISOString();
  const jaTem = new Map(existentes.map((b) => [chave(b.startsAt), b]));

  let criados = 0;
  const manter = new Set<string>();

  for (const feriado of desejados) {
    const { startsAt, endsAt } = intervaloDoFeriado(feriado, tenant.timezone);
    const k = chave(startsAt);
    manter.add(k);
    if (jaTem.has(k)) continue;

    await prisma.block.create({
      data: {
        tenantId: tenant.id,
        doctorId: null,
        startsAt,
        endsAt,
        reason: `${PREFIXO_FERIADO}${feriado.nome}`,
      },
    });
    criados++;
  }

  // O que este job criou e não é mais desejado sai — senão desligar o recurso
  // (ou os facultativos) deixaria a clínica fechada num dia útil, para sempre.
  const sobrando = existentes.filter((b) => !manter.has(chave(b.startsAt))).map((b) => b.id);
  if (sobrando.length) {
    await prisma.block.deleteMany({ where: { id: { in: sobrando } } });
  }

  return { criados, removidos: sobrando.length };
}

/** Sincroniza os feriados de todas as clínicas com o recurso ligado. */
export async function sincronizarFeriadosDeTodas(
  agora = new Date(),
): Promise<{ criados: number; removidos: number }> {
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

    try {
      const r = await sincronizarFeriados(tenant, config, agora);
      criados += r.criados;
      removidos += r.removidos;
    } catch (err) {
      logger.error({ err, tenant: tenant.slug }, "falha ao sincronizar os feriados");
    }
  }

  if (criados || removidos) {
    logger.info({ criados, removidos }, "feriados nacionais sincronizados");
  }
  return { criados, removidos };
}
