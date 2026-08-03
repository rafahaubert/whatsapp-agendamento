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
    /**
     * Duração padrão de uma consulta. Cada especialidade pode ter a sua própria
     * (`Specialty.durationMinutes`); este valor vale para quem não definiu.
     */
    slotDurationMinutes: number;
    /**
     * Minutos entre uma consulta e a seguinte do mesmo profissional (padrão: 0).
     *
     * É o tempo de higienizar a sala, anotar o prontuário, respirar. Sem ele a
     * agenda encosta um paciente no outro e o atraso da manhã inteira nasce da
     * primeira consulta que passa cinco minutos do previsto.
     */
    bufferMinutes?: number;
    maxOptionsOffered: number; // regra de negócio: ofertar 3 horários
    advanceBookingDays: number; // janela p/ frente
    allowCancellation: boolean;
    allowReschedule: boolean;
    /** Se o agente deve perguntar convênio/particular durante o fluxo. */
    askInsurance: boolean;
    /** Se a clínica aceita atendimento particular. */
    acceptParticular: boolean;
    /**
     * Fecha a agenda nos feriados NACIONAIS automaticamente.
     *
     * Sem isto a clínica precisa lembrar de bloquear o Carnaval na mão todo ano
     * — e quando esquece, o agente passa a terça-feira oferecendo horários com
     * a porta fechada. Feriados municipais e estaduais continuam manuais: variam
     * demais para chutar.
     */
    feriadosNacionais?: {
      enabled: boolean;
      /** Carnaval e Corpus Christi (não são feriado por lei, mas quase todo mundo fecha). */
      incluirFacultativos: boolean;
    };
  };

  ai: {
    /** ID do modelo Anthropic. Ex.: "claude-haiku-4-5" (custo), "claude-opus-4-8" (mais capaz), "claude-sonnet-5" (equilíbrio). */
    model: string;
    /** Tom/estilo injetado no system prompt. Nos modelos atuais o tom se controla por prompt (não há `temperature`). */
    persona: string;
  };

  /**
   * Segundos de espera antes de responder. O paciente costuma picotar o pedido
   * em duas ou três mensagens seguidas; esperar um pouco agrupa tudo numa
   * resposta só, em vez de responder por cima de quem ainda está digitando.
   * Padrão: 8.
   */
  debounceSeconds?: number;

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
    /**
     * Carência: horas mínimas entre AGENDAR e receber o lembrete (padrão: 6).
     *
     * Sem ela, quem marca hoje para amanhã com `hoursBefore: 24` recebe o
     * lembrete no ciclo seguinte de 10 minutos — paga-se um template à Meta
     * para lembrar o paciente de algo que ele acabou de fazer, e o "lembrete
     * anti-falta" vira ruído.
     */
    minHorasAposAgendar?: number;
    /** Nome do template aprovado na Meta. */
    templateName: string;
    /** Código do idioma do template (ex.: "pt_BR"). */
    templateLang: string;
  };

  /**
   * Sinal por Pix — o único remédio de verdade contra falta: quem pagou aparece.
   *
   * O agente manda o copia-e-cola pronto (gerado localmente, sem gateway), o
   * paciente cola no banco e o valor já vem preenchido. A BAIXA É MANUAL: o
   * sistema não confirma o pagamento, só facilita fazê-lo. Integrar um gateway
   * (Mercado Pago, Asaas) automatizaria a confirmação — é decisão de fornecedor,
   * não detalhe de implementação.
   */
  payment?: {
    pixEnabled: boolean;
    /** A chave, como cadastrada no banco. */
    chave: string;
    tipoChave: "cpf" | "cnpj" | "email" | "telefone" | "aleatoria";
    /** Nome do beneficiário no comprovante (sem acento, até 25 caracteres). */
    beneficiario: string;
    /** Cidade do beneficiário (até 15 caracteres). */
    cidade: string;
    /** Valor do sinal em CENTAVOS. 0 ou vazio = o paciente digita o valor. */
    sinalCentavos?: number;
    /** Texto que acompanha o Pix (prazo, o que fazer com o comprovante…). */
    instrucoes?: string;
  };

  /** Fila de espera: avisa quando um horário é liberado por cancelamento. */
  waitlist?: {
    enabled: boolean;
    templateName: string;
    templateLang: string;
  };

  /**
   * Desfecho da consulta — a base da TAXA DE FALTA, que é a métrica que sustenta
   * a renovação do contrato.
   *
   * Antes ela dependia de a recepção clicar "compareceu" no painel: sem o
   * clique, o agendamento ficava SCHEDULED para sempre e a taxa não fechava —
   * justamente na clínica com menos disciplina, que é a que mais precisa do
   * produto.
   *
   * Duas frentes: perguntar ao paciente (de graça, dentro da janela de 24h da
   * Meta) e, no silêncio, presumir comparecimento depois de alguns dias. O que
   * for presumido fica marcado como tal — o painel não vende estimativa como
   * fato.
   */
  outcome?: {
    enabled: boolean;
    /** Horas após o fim da consulta para perguntar ao paciente (padrão: 3). */
    horasAposConsulta?: number;
    /** Dias sem resposta até presumir comparecimento (padrão: 3). 0 = nunca presume. */
    diasParaPresumir?: number;
  };

  /** Reativação: convida de volta quem não vem há alguns meses. */
  recall?: {
    enabled: boolean;
    /** Meses sem consulta para entrar no convite (ex.: 6). */
    months: number;
    templateName: string;
    templateLang: string;
  };

  /**
   * Follow-up de conversa abandonada: cutuca UMA vez quem parou no meio do
   * fluxo (ex.: sumiu depois de "qual seu nome?").
   *
   * Não precisa de template aprovado: dentro da janela de 24h da Meta a
   * resposta é mensagem livre. Por isso é a automação mais barata das quatro.
   */
  followUp?: {
    enabled: boolean;
    /** Minutos de silêncio antes de cutucar (padrão: 30). */
    minutesAfter: number;
    /** Texto da cutucada. Vazio = usa o padrão do job. */
    message?: string;
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
