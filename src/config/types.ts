/**
 * Contrato de configuração de um cliente (clínica).
 *
 * Cada clínica é descrita por UM arquivo config/clinics/<slug>.json que satisfaz
 * `ClinicFile`. Ele tem duas partes:
 *   - `config`  → comportamento/branding (vai para Tenant.config, serializado)
 *   - `catalog` → dados de catálogo (unidades, especialidades, convênios, médicos)
 *                 usados pelo seed para popular as tabelas.
 *
 * Regra de ouro: o que muda entre clínicas é CONFIGURAÇÃO, não código.
 */

// ---------- Horário de um dia ----------
/**
 * Faixa de atendimento de um dia, com intervalo opcional (almoço).
 * Sem `breakStart`/`breakEnd` o comportamento é o de antes: faixa contínua.
 */
export interface DiaAtendimento {
  open: string; // "08:00"
  close: string; // "18:00"
  breakStart?: string; // "12:00"
  breakEnd?: string; // "13:00"
}

// ---------- Comportamento / branding (Tenant.config) ----------
export interface TenantConfig {
  branding: {
    clinicName: string;
    greetingMessage: string; // primeira mensagem ao paciente
    fallbackMessage: string; // quando não entende / pede atendente
    closingMessage: string; // após concluir o agendamento
  };

  businessHours: {
    timezone: string; // "America/Sao_Paulo"
    /** 0=domingo ... 6=sábado. null = fechado. */
    days: Record<number, DiaAtendimento | null>;
  };

  booking: {
    slotDurationMinutes: number;
    maxOptionsOffered: number; // regra de negócio: ofertar 3 horários
    advanceBookingDays: number; // janela p/ frente
    allowCancellation: boolean;
    allowReschedule: boolean;
    /** Se o agente deve perguntar convênio/particular durante o fluxo. */
    askInsurance: boolean;
    /** Se a clínica aceita atendimento particular. */
    acceptParticular: boolean;
  };

  ai: {
    /** ID do modelo Anthropic. Ex.: "claude-haiku-4-5" (custo), "claude-opus-4-8" (mais capaz), "claude-sonnet-5" (equilíbrio). */
    model: string;
    /** Tom/estilo injetado no system prompt. Nos modelos atuais o tom se controla por prompt (não há `temperature`). */
    persona: string;
  };

  /**
   * Base de conhecimento / FAQ da clínica (texto livre) — injetada no prompt para
   * o agente responder perguntas gerais (procedimentos, pagamento, localização…).
   */
  knowledgeBase?: string;

  /**
   * Lembrete automático de consulta (reduz faltas). Exige um template aprovado
   * na Meta — ver WHATSAPP-TEMPLATES.md.
   */
  reminders?: {
    enabled: boolean;
    /** Horas de antecedência do envio (ex.: 24). */
    hoursBefore: number;
    /** Nome do template aprovado na Meta. */
    templateName: string;
    /** Código do idioma do template (ex.: "pt_BR"). */
    templateLang: string;
  };

  /** Fila de espera: avisa quando um horário é liberado por cancelamento. */
  waitlist?: {
    enabled: boolean;
    templateName: string;
    templateLang: string;
  };

  /** Reativação: convida de volta quem não vem há alguns meses. */
  recall?: {
    enabled: boolean;
    /** Meses sem consulta para entrar no convite (ex.: 6). */
    months: number;
    templateName: string;
    templateLang: string;
  };
}

// ---------- Catálogo (seed) ----------
export interface ClinicCatalog {
  units: {
    name: string;
    address?: string;
    phone?: string;
    timezone?: string;
  }[];

  specialties: string[];

  /** Convênios e seus planos. */
  insurers: {
    name: string; // "Unimed"
    code?: string; // registro ANS
    plans: string[]; // ["Unimed Nacional", "Unimed Estadual"]
  }[];

  doctors: {
    name: string;
    crm?: string;
    specialties: string[]; // nomes presentes em `specialties`
    units: string[]; // nomes presentes em `units`
    /** Nomes de planos aceitos (presentes em insurers[].plans). Vazio = só particular. */
    acceptedPlans?: string[];
  }[];
}

// ---------- Arquivo completo por clínica ----------
export interface ClinicFile {
  slug: string;
  name: string;
  whatsappPhoneNumberId: string;
  whatsappBusinessId?: string;
  timezone?: string;
  config: TenantConfig;
  catalog: ClinicCatalog;
}
