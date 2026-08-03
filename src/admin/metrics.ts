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
  /**
   * Quantos desfechos foram PRESUMIDOS por falta de resposta (src/jobs/desfecho.ts).
   *
   * Vai junto da taxa de falta de propósito: sem este número, uma taxa calculada
   * quase toda em cima de presunção pareceria tão firme quanto uma apurada
   * paciente a paciente.
   */
  desfechosPresumidos: number;
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

  // ---------- Dinheiro e agenda cheia ----------
  /**
   * Faturamento REALIZADO no período (centavos): consultas que aconteceram.
   *
   * Sai de `Specialty.priceCents`, então só conta o que tem preço cadastrado —
   * `consultasSemPreco` diz quanto ficou de fora. Convênio não entra: o valor
   * depende do plano e a clínica não o registra aqui.
   */
  faturamentoCentavos: number;
  /** Faturamento AGENDADO e ainda não realizado (centavos). */
  faturamentoPrevistoCentavos: number;
  /**
   * Consultas do período que não puderam ser precificadas.
   *
   * Vai junto do faturamento de propósito: um número grande aqui significa que
   * o total mostrado é uma fração do real, e apresentá-lo sem esse contexto
   * faria a clínica achar que fatura menos do que fatura.
   */
  consultasSemPreco: number;
  /** Faturamento realizado por especialidade, do maior para o menor. */
  faturamentoPorEspecialidade: { especialidade: string; centavos: number; consultas: number }[];

  /**
   * Ocupação da agenda À FRENTE (%), não do período que passou.
   *
   * A distinção não é preciosismo: os horários livres do passado são APAGADOS
   * na renovação diária, então não existe mais como saber quantos ficaram
   * vazios ontem. O que dá para medir — e é o que a clínica pode agir sobre — é
   * quanto da agenda que vem já está preenchido.
   */
  ocupacaoAdiante: number | null;
  /** Horários livres na janela à frente (a agenda ociosa que dá para vender). */
  horariosLivresAdiante: number;
  /** Dias da janela à frente considerados na ocupação. */
  diasAdiante: number;
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

/** Uma consulta, do ponto de vista do faturamento. */
export interface ConsultaFaturavel {
  status: string;
  /** Preço da especialidade em centavos; `null` = sem preço cadastrado. */
  precoCentavos: number | null;
  especialidade: string;
  /** PARTICULAR | HEALTH_PLAN. */
  paymentType: string;
}

export interface Faturamento {
  realizadoCentavos: number;
  previstoCentavos: number;
  semPreco: number;
  porEspecialidade: { especialidade: string; centavos: number; consultas: number }[];
}

/**
 * Regra pura (testável): quanto a clínica faturou e quanto tem a faturar.
 *
 * Duas exclusões deliberadas, e as duas mudam o número:
 *
 * - CONVÊNIO fica de fora. O valor depende do plano e do repasse, e a clínica
 *   não registra isso aqui — somar o preço particular de um atendimento por
 *   convênio inflaria o faturamento com dinheiro que não entrou.
 * - Consulta SEM PREÇO cadastrado não vira zero, vira `semPreco`. Zero somaria
 *   silenciosamente para baixo e a clínica acharia que fatura menos do que fatura.
 */
export function calcularFaturamento(consultas: ConsultaFaturavel[]): Faturamento {
  const realizados: string[] = [AppointmentStatus.COMPLETED];
  const previstos: string[] = [
    AppointmentStatus.SCHEDULED,
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.RESCHEDULED,
  ];

  let realizadoCentavos = 0;
  let previstoCentavos = 0;
  let semPreco = 0;
  const porEsp = new Map<string, { centavos: number; consultas: number }>();

  for (const c of consultas) {
    const conta = realizados.includes(c.status) || previstos.includes(c.status);
    if (!conta) continue; // cancelada ou falta não fatura
    if (c.paymentType !== "PARTICULAR") continue;

    if (c.precoCentavos == null) {
      semPreco++;
      continue;
    }

    if (realizados.includes(c.status)) {
      realizadoCentavos += c.precoCentavos;
      const atual = porEsp.get(c.especialidade) ?? { centavos: 0, consultas: 0 };
      porEsp.set(c.especialidade, {
        centavos: atual.centavos + c.precoCentavos,
        consultas: atual.consultas + 1,
      });
    } else {
      previstoCentavos += c.precoCentavos;
    }
  }

  const porEspecialidade = [...porEsp.entries()]
    .map(([especialidade, v]) => ({ especialidade, ...v }))
    .sort((a, b) => b.centavos - a.centavos);

  return { realizadoCentavos, previstoCentavos, semPreco, porEspecialidade };
}

/**
 * Regra pura (testável): quanto da agenda à frente já está preenchido.
 *
 * `null` quando não há agenda gerada — sem horário nenhum, 0% e 100% seriam
 * igualmente falsos.
 */
export function calcularOcupacao(ocupados: number, livres: number): number | null {
  const total = ocupados + livres;
  return total > 0 ? (ocupados / total) * 100 : null;
}

export async function calcularMetricas(
  tenantId: string,
  config: TenantConfig,
  timezone: string,
  dias: number,
): Promise<Metricas> {
  const desde = new Date(Date.now() - dias * 86_400_000);
  // A ocupação olha para a frente pela mesma janela de dias que o relatório
  // olha para trás — assim os dois números falam da mesma escala de tempo.
  const diasAdiante = Math.min(dias, config.booking.advanceBookingDays || 30);
  const ateAdiante = new Date(Date.now() + diasAdiante * 86_400_000);

  const [
    porStatus,
    criados,
    lembretes,
    mensagens,
    conversas,
    consumo,
    presumidos,
    paraFaturar,
    slotsAdiante,
  ] = await Promise.all([
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
    // Quanto da taxa de falta é presunção, e não desfecho apurado.
    prisma.appointment.count({
      where: { tenantId, outcomeAuto: true, slot: { startsAt: { gte: desde } } },
    }),
    // Faturamento: preço vem da especialidade, não da consulta.
    prisma.appointment.findMany({
      where: { tenantId, slot: { startsAt: { gte: desde } } },
      select: {
        status: true,
        paymentType: true,
        specialty: { select: { name: true, priceCents: true } },
      },
      take: 20_000,
    }),
    // Ocupação: só faz sentido ADIANTE. Os horários livres do passado são
    // apagados na renovação diária, então não há como saber quantos ficaram
    // vazios ontem — ver o comentário em `Metricas.ocupacaoAdiante`.
    prisma.slot.groupBy({
      by: ["status"],
      where: { tenantId, startsAt: { gte: new Date(), lte: ateAdiante } },
      _count: { _all: true },
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

  const faturamento = calcularFaturamento(
    paraFaturar.map((a) => ({
      status: a.status,
      paymentType: a.paymentType,
      especialidade: a.specialty.name,
      precoCentavos: a.specialty.priceCents,
    })),
  );

  const contarSlots = (status: string) =>
    slotsAdiante.find((s) => s.status === status)?._count._all ?? 0;
  const ocupados = contarSlots("BOOKED");
  const livres = contarSlots("AVAILABLE");

  return {
    dias,
    agendamentos: criados,
    confirmados: contar(AppointmentStatus.CONFIRMED),
    cancelados: contar(AppointmentStatus.CANCELLED),
    compareceram,
    faltaram,
    taxaFalta: realizadas > 0 ? (faltaram / realizadas) * 100 : null,
    desfechosPresumidos: presumidos,
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
    faturamentoCentavos: faturamento.realizadoCentavos,
    faturamentoPrevistoCentavos: faturamento.previstoCentavos,
    consultasSemPreco: faturamento.semPreco,
    faturamentoPorEspecialidade: faturamento.porEspecialidade,
    ocupacaoAdiante: calcularOcupacao(ocupados, livres),
    horariosLivresAdiante: livres,
    diasAdiante,
  };
}
