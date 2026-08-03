/**
 * Métricas do painel — é o que mostra o RETORNO para a clínica (e sustenta a
 * renovação do contrato) e o que te dá base real de custo por cliente.
 */
import { DateTime } from "luxon";
import { prisma } from "../db/client.js";
import { AppointmentStatus } from "../shared/enums.js";
import type { TenantConfig, DiaAtendimento } from "../config/types.js";
import { perfilDoModelo, precoDoModelo } from "../ai/modelos.js";

/**
 * Multiplicadores do prompt caching sobre o preço de ENTRADA.
 * Gravar no cache custa mais que input normal; ler custa quase nada. Ignorar
 * isso e cobrar tudo a 1x mostraria uma economia que não existe (ou esconderia
 * o custo extra da escrita).
 */
const MULT_ESCRITA_CACHE = 1.25;
const MULT_LEITURA_CACHE = 0.1;

/** Consumo de um período, nas quatro faixas que a API cobra separado. */
export interface ConsumoTokens {
  entrada: number;
  saida: number;
  cacheEscrita: number;
  cacheLeitura: number;
}

/**
 * Regra pura (testável): quanto custou o consumo e quanto o cache poupou.
 *
 * Fica separada porque é onde o erro passa despercebido: cobrar tudo a 1x
 * mostraria uma economia inexistente (a escrita de cache custa MAIS que input
 * normal) e esconderia o custo real por clínica.
 */
export function calcularCustoUSD(
  consumo: ConsumoTokens,
  modelo: string,
  quando: Date = new Date(),
): { custoUSD: number; economiaCacheUSD: number } {
  const preco = precoDoModelo(modelo, quando);
  const porMtok = (tokens: number, precoMtok: number) => (tokens / 1_000_000) * precoMtok;

  const custoUSD =
    porMtok(consumo.entrada, preco.entrada) +
    porMtok(consumo.cacheEscrita, preco.entrada * MULT_ESCRITA_CACHE) +
    porMtok(consumo.cacheLeitura, preco.entrada * MULT_LEITURA_CACHE) +
    porMtok(consumo.saida, preco.saida);

  // O que os tokens LIDOS do cache teriam custado a preço cheio, menos o que
  // custaram de fato. A escrita não entra: ela é o investimento, não a economia.
  const economiaCacheUSD = porMtok(
    consumo.cacheLeitura,
    preco.entrada * (1 - MULT_LEITURA_CACHE),
  );

  return { custoUSD, economiaCacheUSD };
}

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
  tokensCacheEscrita: number;
  tokensCacheLeitura: number;
  custoEstimadoUSD: number;
  /** Quanto o prompt caching poupou no período (US$). 0 = cache não pegou. */
  economiaCacheUSD: number;
  /**
   * O prompt caching está pegando? `null` = ainda sem volume para dizer.
   *
   * É o sinal que faltava: sem ele, cache desligado e cache que não compensou
   * ficam idênticos no painel (economia zero nos dois casos). Ver
   * `minPrefixoCacheModelo` para o motivo mais comum de `false`.
   */
  cacheAtivo: boolean | null;
  /** Prefixo mínimo que o modelo configurado exige para cachear (tokens). */
  minPrefixoCacheModelo: number;
}

/**
 * Regra pura (testável): o cache está pegando?
 *
 * Só responde quando há consumo suficiente para a pergunta fazer sentido — com
 * duas ou três mensagens no período, leitura zero não significa nada (a primeira
 * chamada sempre grava, nunca lê).
 */
export function diagnosticarCache(
  consumo: ConsumoTokens,
  minRespostas = 10,
  respostas = minRespostas,
): boolean | null {
  const totalEntrada = consumo.entrada + consumo.cacheEscrita + consumo.cacheLeitura;
  if (respostas < minRespostas || totalEntrada === 0) return null;
  return consumo.cacheLeitura > 0;
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
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheCreationTokens: true,
        cacheReadTokens: true,
      },
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

  const tokensEntrada = consumo._sum.inputTokens ?? 0;
  const tokensSaida = consumo._sum.outputTokens ?? 0;
  const tokensCacheEscrita = consumo._sum.cacheCreationTokens ?? 0;
  const tokensCacheLeitura = consumo._sum.cacheReadTokens ?? 0;

  const consumoTokens: ConsumoTokens = {
    entrada: tokensEntrada,
    saida: tokensSaida,
    cacheEscrita: tokensCacheEscrita,
    cacheLeitura: tokensCacheLeitura,
  };

  const { custoUSD, economiaCacheUSD } = calcularCustoUSD(consumoTokens, config.ai.model);

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
    tokensCacheEscrita,
    tokensCacheLeitura,
    custoEstimadoUSD: custoUSD,
    economiaCacheUSD,
    cacheAtivo: diagnosticarCache(consumoTokens, 10, mensagens.length - recebidas.length),
    minPrefixoCacheModelo: perfilDoModelo(config.ai.model).minPrefixoCache,
  };
}
