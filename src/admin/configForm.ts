/**
 * Leitura do formulário de configuração da clínica.
 *
 * A configuração vive num JSON único (Tenant.config), mas o painel a edita em
 * páginas separadas — Dados da clínica, Templates de mensagens, e por aí. Um
 * formulário só manda os campos da SUA página, então reconstruir a config
 * inteira a partir do corpo apagaria tudo que ficou de fora: uma caixa
 * desmarcada e um campo ausente chegam idênticos aqui (os dois somem do POST).
 * Salvar "Dados da clínica" desligaria lembrete, fila e reativação, e fecharia
 * a clínica nos sete dias da semana.
 *
 * Por isso cada formulário declara em `_blocos` o que carrega, e a mesclagem
 * abaixo só reescreve os blocos declarados. O resto vem da config atual.
 */
import type { TenantConfig, DiaAtendimento } from "../config/types.js";
import { MODELO_PADRAO, PERFIS } from "../ai/modelos.js";

/** Blocos editáveis. O nome vai no `_blocos` do formulário que os contém. */
export const BLOCOS = [
  "identificacao", // nome, fuso, ativa, phone number id (colunas do Tenant)
  "mensagens", // saudação, fallback, encerramento
  "horario", // horário de funcionamento
  "regras", // regras de agendamento + debounce
  "ia", // modelo e persona
  "faq", // base de conhecimento
  "lembrete", // lembrete de consulta
  "fila", // fila de espera
  "reativacao", // reativação de pacientes
  "followup", // follow-up de conversa abandonada
  "desfecho", // apuração de comparecimento (base da taxa de falta)
] as const;
export type Bloco = (typeof BLOCOS)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Corpo = any;

function bool(v: unknown): boolean {
  return v === "on" || v === "true" || v === true || v === "1";
}

function num(v: unknown, padrao: number): number {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : padrao;
}

/** "08:00" … "23:59". */
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Hora do formulário, ou o padrão se não for HH:MM.
 *
 * Não é só higiene de dados: o horário de funcionamento é copiado LITERALMENTE
 * para o system prompt (`resumoAgenda` monta "seg, ter: <open> às <close>"), e
 * `escapePrompt` não passa por aqui. Sem esta validação, quem edita a clínica
 * escreve texto livre — instruções inclusive — dentro do prompt do agente.
 */
function hora(v: unknown, padrao: string): string {
  const s = String(v ?? "").trim();
  return HORA_RE.test(s) ? s : padrao;
}

/**
 * Fuso horário IANA aceito pelo runtime? Um valor inválido quebrava o motor
 * (`Intl.DateTimeFormat` lança e o lote morria sem resposta) e também entrava
 * cru no system prompt.
 */
export function fusoValido(v: unknown): boolean {
  if (typeof v !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** Fuso do formulário, ou o padrão se não for um IANA válido. */
export function lerTimezone(v: unknown, padrao: string): string {
  return fusoValido(v) ? String(v).trim() : padrao;
}

/** Blocos declarados pelo formulário, em `_blocos` (separados por espaço). */
export function blocosDoCorpo(body: Corpo): Bloco[] {
  return String(body?._blocos ?? "")
    .split(/\s+/)
    .filter((b): b is Bloco => (BLOCOS as readonly string[]).includes(b));
}

function lerDias(body: Corpo): Record<number, DiaAtendimento | null> {
  const days: Record<number, DiaAtendimento | null> = {};
  for (let i = 0; i < 7; i++) {
    if (!bool(body[`day_${i}_aberto`])) {
      days[i] = null;
      continue;
    }
    const inicioIntervalo = String(body[`day_${i}_break_start`] ?? "").trim();
    const fimIntervalo = String(body[`day_${i}_break_end`] ?? "").trim();
    const temIntervalo = HORA_RE.test(inicioIntervalo) && HORA_RE.test(fimIntervalo);
    days[i] = {
      open: hora(body[`day_${i}_open`], "08:00"),
      close: hora(body[`day_${i}_close`], "18:00"),
      // Intervalo (almoço) é opcional: só entra se as duas pontas forem horas válidas.
      ...(temIntervalo ? { breakStart: inicioIntervalo, breakEnd: fimIntervalo } : {}),
    };
  }
  return days;
}

/**
 * Mescla o formulário sobre a configuração atual. Só os blocos declarados são
 * reescritos — o que não veio no POST fica exatamente como estava.
 */
export function parseConfig(
  body: Corpo,
  timezone: string,
  atual: TenantConfig,
  blocos: Bloco[],
): TenantConfig {
  const tem = (b: Bloco) => blocos.includes(b);
  const cfg: TenantConfig = {
    ...atual,
    // O fuso mora no Tenant e é espelhado aqui; acompanha sempre o valor em vigor.
    businessHours: { ...atual.businessHours, timezone },
  };

  if (tem("mensagens")) {
    cfg.branding = {
      clinicName: body.branding_clinicName ?? atual.branding.clinicName ?? "",
      greetingMessage: body.branding_greeting ?? "",
      fallbackMessage: body.branding_fallback ?? "",
      closingMessage: body.branding_closing ?? "",
    };
  }

  if (tem("horario")) {
    cfg.businessHours = { timezone, days: lerDias(body) };
  }

  if (tem("regras")) {
    cfg.booking = {
      slotDurationMinutes: num(body.booking_slotDurationMinutes, 30),
      maxOptionsOffered: num(body.booking_maxOptionsOffered, 3),
      advanceBookingDays: num(body.booking_advanceBookingDays, 30),
      allowCancellation: bool(body.booking_allowCancellation),
      allowReschedule: bool(body.booking_allowReschedule),
      askInsurance: bool(body.booking_askInsurance),
      acceptParticular: bool(body.booking_acceptParticular),
    };
    cfg.debounceSeconds = num(body.debounceSeconds, 8);
  }

  if (tem("ia")) {
    // Modelo desconhecido cai no padrão em vez de ser gravado: um id inválido
    // (dedo pesado no formulário, modelo aposentado numa config antiga) só
    // apareceria como 404 da Anthropic em cima da conversa do paciente.
    const pedido = body.ai_model ?? atual.ai.model;
    cfg.ai = {
      model: pedido && PERFIS[pedido] ? pedido : MODELO_PADRAO,
      persona: body.ai_persona ?? "",
    };
  }

  if (tem("faq")) {
    cfg.knowledgeBase = (body.knowledgeBase ?? "").trim() || undefined;
  }

  if (tem("lembrete")) {
    cfg.reminders = {
      enabled: bool(body.reminders_enabled),
      hoursBefore: num(body.reminders_hoursBefore, 24),
      minHorasAposAgendar: num(body.reminders_minHorasAposAgendar, 6),
      templateName: (body.reminders_templateName ?? "").trim(),
      templateLang: (body.reminders_templateLang ?? "pt_BR").trim() || "pt_BR",
    };
  }

  if (tem("fila")) {
    cfg.waitlist = {
      enabled: bool(body.waitlist_enabled),
      templateName: (body.waitlist_templateName ?? "").trim(),
      templateLang: (body.waitlist_templateLang ?? "pt_BR").trim() || "pt_BR",
    };
  }

  if (tem("reativacao")) {
    cfg.recall = {
      enabled: bool(body.recall_enabled),
      months: num(body.recall_months, 6),
      templateName: (body.recall_templateName ?? "").trim(),
      templateLang: (body.recall_templateLang ?? "pt_BR").trim() || "pt_BR",
    };
  }

  if (tem("followup")) {
    cfg.followUp = {
      enabled: bool(body.followUp_enabled),
      minutesAfter: num(body.followUp_minutesAfter, 30),
      message: (body.followUp_message ?? "").trim() || undefined,
    };
  }

  if (tem("desfecho")) {
    cfg.outcome = {
      enabled: bool(body.outcome_enabled),
      horasAposConsulta: num(body.outcome_horasAposConsulta, 3),
      diasParaPresumir: num(body.outcome_diasParaPresumir, 3),
    };
  }

  return cfg;
}
