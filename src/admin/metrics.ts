/**
 * Métricas do painel — é o que mostra o RETORNO para a clínica (e sustenta a
 * renovação do contrato) e o que te dá base real de custo por cliente.
 */
import { DateTime } from "luxon";
import { prisma } from "../db/client.js";
import { AppointmentStatus } from "../shared/enums.js";
import type { TenantConfig, DiaAtendimento } from "../config/types.js";

/** Preço por milhão de tokens (US$). Estimativa — confira os valores atuais. */
const PRECO_POR_MTOK: Record<string, { entrada: number; saida: number }> = {
  "claude-haiku-4-5": { entrada: 1, saida: 5 },
  "claude-sonnet-5": { entrada: 3, saida: 15 },
  "claude-opus-4-8": { entrada: 5, saida: 25 },
};

/**
 * A mensagem chegou fora do horário de funcionamento? (regra pura, testável)
 * É o argumento de venda: "X% dos pacientes escreveram quando a clínica estava
 * fechada — e todos foram atendidos".
 */
export function foraDoHorario(
  quando: Date,
  timezone: string,
  days: Record<number, DiaAtendimento | null>,
): boolean {
  const dt = DateTime.fromJSDate(quando).setZone(timezone);
  const diaSemana = dt.weekday === 7 ? 0 : dt.weekday; // luxon: 1=seg..7=dom
  const dia = days[diaSemana];
  if (!dia) return true; // dia fechado

  const minutos = dt.hour * 60 + dt.minute;
  const abre = Number(dia.open.split(":")[0]) * 60 + Number(dia.open.split(":")[1] || 0);
  const fecha = Number(dia.close.split(":")[0]) * 60 + Number(dia.close.split(":")[1] || 0);
  return minutos < abre || minutos >= fecha;
}

export interface Metricas {
  dias: number;
  agendamentos: number;
  confirmados: number;
  cancelados: number;
  compareceram: number;
  faltaram: number;
  taxaFalta: number | null; // null = ainda sem dados
  lembretesEnviados: number;
  lembretesConfirmados: number;
  taxaConfirmacao: number | null;
  mensagensRecebidas: number;
  mensagensEnviadas: number;
  foraDoHorario: number;
  percentualForaHorario: number | null;
  conversas: number;
  // Só para o operador da plataforma:
  tokensEntrada: number;
  tokensSaida: number;
  custoEstimadoUSD: number;
}

export async function calcularMetricas(
  tenantId: string,
  config: TenantConfig,
  timezone: string,
  dias: number,
): Promise<Metricas> {
  const desde = new Date(Date.now() - dias * 86_400_000);

  const [porStatus, criados, lembretes, mensagens, conversas, consumo] = await Promise.all([
    // Desfecho das consultas do período (pela data da consulta).
    prisma.appointment.groupBy({
      by: ["status"],
      where: { tenantId, slot: { startsAt: { gte: desde } } },
      _count: { _all: true },
    }),
    prisma.appointment.count({ where: { tenantId, createdAt: { gte: desde } } }),
    prisma.appointment.findMany({
      where: { tenantId, reminderSentAt: { gte: desde } },
      select: { confirmedAt: true },
    }),
    prisma.message.findMany({
      where: { tenantId, createdAt: { gte: desde } },
      select: { direction: true, createdAt: true },
      take: 20_000,
    }),
    prisma.conversation.count({ where: { tenantId, lastMessageAt: { gte: desde } } }),
    prisma.message.aggregate({
      where: { tenantId, createdAt: { gte: desde } },
      _sum: { inputTokens: true, outputTokens: true },
    }),
  ]);

  const contar = (status: string) =>
    porStatus.find((s) => s.status === status)?._count._all ?? 0;

  const compareceram = contar(AppointmentStatus.COMPLETED);
  const faltaram = contar(AppointmentStatus.NO_SHOW);
  const realizadas = compareceram + faltaram;

  const recebidas = mensagens.filter((m) => m.direction === "IN");
  const fora = recebidas.filter((m) =>
    foraDoHorario(m.createdAt, timezone, config.businessHours.days),
  ).length;

  const lembretesConfirmados = lembretes.filter((a) => a.confirmedAt !== null).length;

  const preco = PRECO_POR_MTOK[config.ai.model] ?? PRECO_POR_MTOK["claude-haiku-4-5"];
  const tokensEntrada = consumo._sum.inputTokens ?? 0;
  const tokensSaida = consumo._sum.outputTokens ?? 0;

  return {
    dias,
    agendamentos: criados,
    confirmados: contar(AppointmentStatus.CONFIRMED),
    cancelados: contar(AppointmentStatus.CANCELLED),
    compareceram,
    faltaram,
    taxaFalta: realizadas > 0 ? (faltaram / realizadas) * 100 : null,
    lembretesEnviados: lembretes.length,
    lembretesConfirmados,
    taxaConfirmacao: lembretes.length > 0 ? (lembretesConfirmados / lembretes.length) * 100 : null,
    mensagensRecebidas: recebidas.length,
    mensagensEnviadas: mensagens.length - recebidas.length,
    foraDoHorario: fora,
    percentualForaHorario: recebidas.length > 0 ? (fora / recebidas.length) * 100 : null,
    conversas,
    tokensEntrada,
    tokensSaida,
    custoEstimadoUSD:
      (tokensEntrada / 1_000_000) * preco.entrada + (tokensSaida / 1_000_000) * preco.saida,
  };
}
