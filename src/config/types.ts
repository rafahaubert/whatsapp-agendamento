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
    days: Record<number, { open: string; close: string } | null>;
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
