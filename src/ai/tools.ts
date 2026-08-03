import type Anthropic from "@anthropic-ai/sdk";
import type { ResolvedTenant } from "../db/tenantRepository.js";
import { PaymentType } from "../shared/enums.js";
import { ehConfirmacao } from "../shared/confirmacao.js";
import * as scheduling from "../domain/scheduling.js";
import { gerarCopiaECola } from "../domain/pix.js";

/**
 * Monta o Pix do sinal desta clínica.
 *
 * O copia-e-cola é gerado AQUI, e não pedido ao modelo: são ~130 caracteres com
 * um CRC no fim, e qualquer alteração — um espaço, uma quebra de linha — o
 * invalida no banco. O modelo só repassa o que a ferramenta devolveu.
 */
function gerarPixDoSinal(tenant: ResolvedTenant, appointmentId?: string) {
  const pg = tenant.config.payment;
  if (!pg?.pixEnabled || !pg.chave) {
    return { erro: "Esta clínica não cobra sinal por Pix. Não ofereça pagamento antecipado." };
  }

  const copiaECola = gerarCopiaECola({
    chave: pg.chave,
    tipo: pg.tipoChave,
    beneficiario: pg.beneficiario || tenant.name,
    cidade: pg.cidade || "",
    valorCentavos: pg.sinalCentavos,
    // A identificação ajuda a recepção a casar o comprovante com a consulta.
    identificador: appointmentId ? appointmentId.slice(-12) : undefined,
  });

  const valor = pg.sinalCentavos
    ? (pg.sinalCentavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : null;

  return {
    copiaECola,
    valor,
    instrucoes: pg.instrucoes || null,
    comoResponder:
      "Mande o campo copiaECola numa mensagem SEPARADA, sozinho, sem aspas, sem crase e sem texto em volta — ele precisa chegar intacto para o banco aceitar. Explique o valor e o prazo na mensagem anterior.",
  };
}

/**
 * Contexto que atravessa uma conversa. `patientId` é preenchido quando
 * identificar_paciente roda e é persistido no estado da Conversation, de modo
 * que agendar/cancelar não dependem do Claude "lembrar" o id.
 */
export interface ConversationContext {
  tenant: ResolvedTenant;
  phone: string;
  patientId?: string;
  /** Ligado pela ferramenta chamar_atendente; o motor persiste ao fim do turno. */
  handoffRequested?: boolean;
  /** Última fala do paciente neste turno — usada para exigir confirmação antes de agendar. */
  ultimaMensagemPaciente?: string;
}

/** Catálogo completo. Use `buildTools(tenant)` — ele filtra o que a clínica não usa. */
const TODAS: Anthropic.Tool[] = [
  {
    name: "listar_especialidades",
    description: "Lista as especialidades médicas oferecidas pela clínica.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "listar_unidades",
    description: "Lista as unidades/filiais da clínica.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "listar_convenios",
    description: "Lista os convênios e planos de saúde aceitos pela clínica.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "entrar_fila_espera",
    description:
      "Coloca o paciente na fila de espera de uma especialidade. Ofereça isso quando NÃO houver horários disponíveis que sirvam — assim ele é avisado automaticamente se alguém cancelar.",
    input_schema: {
      type: "object",
      properties: {
        especialidade: { type: "string", description: "Nome da especialidade" },
        periodo: {
          type: "string",
          enum: ["manha", "tarde", "noite"],
          description: "Período preferido, se o paciente indicou (opcional)",
        },
      },
      required: ["especialidade"],
    },
  },
  {
    name: "enviar_pix",
    description:
      "Gera o Pix copia-e-cola do SINAL da consulta e devolve o código para o paciente colar no banco. Use DEPOIS de a consulta estar agendada, quando a clínica cobra sinal. Envie o código exatamente como veio, numa mensagem separada e sem nada em volta — qualquer caractere a mais o invalida.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: {
          type: "string",
          description: "ID do agendamento que o sinal está pagando (opcional, vira identificação da cobrança)",
        },
      },
    },
  },
  {
    name: "chamar_atendente",
    description:
      "Transfere a conversa para um atendente humano da recepção. Use quando o paciente pedir para falar com uma pessoa, reclamar, tratar de urgência/dor, ou quando o pedido fugir do agendamento. Depois de chamar, avise que a recepção vai responder.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Resumo curto do motivo (opcional)" },
      },
    },
  },
  {
    name: "listar_medicos",
    description:
      "Lista os profissionais da clínica com suas especialidades, unidades e HORÁRIOS DE ATENDIMENTO. Use quando perguntarem quem atende, ou em que dias/horários um profissional atende.",
    input_schema: {
      type: "object",
      properties: {
        especialidade: {
          type: "string",
          description: "Filtra por especialidade (opcional)",
        },
      },
    },
  },
  {
    name: "identificar_paciente",
    description:
      "Identifica (ou cadastra) o paciente da consulta. Se o telefone JÁ TIVER cadastro, basta o nome — o CPF NÃO é necessário e não deve ser pedido. " +
      "O CPF só entra para cadastrar alguém NOVO; se ele fizer falta, a ferramenta avisa.",
    input_schema: {
      type: "object",
      properties: {
        nome: {
          type: "string",
          description: "Nome do paciente. Completo, quando for um cadastro novo",
        },
        cpf: {
          type: "string",
          description:
            "CPF (com ou sem pontuação). Envie APENAS ao cadastrar um paciente novo — omita para quem já tem cadastro neste telefone (opcional)",
        },
      },
      required: ["nome"],
    },
  },
  {
    name: "listar_horarios",
    description:
      "Busca horários livres de uma especialidade. Retorna no máximo o número de opções configurado pela clínica. " +
      "Além de 'horarios', a resposta pode trazer: 'dia' (o dia a que as opções se referem), " +
      "'exato' (false = o horário pedido NÃO está livre; as opções são as mais próximas) e 'aviso' (o que dizer ao paciente).",
    input_schema: {
      type: "object",
      properties: {
        especialidade: { type: "string", description: "Nome da especialidade" },
        unidade: { type: "string", description: "Nome da unidade (opcional)" },
        plano: {
          type: "string",
          description: "Nome do plano para filtrar médicos que o aceitam (opcional)",
        },
        periodo: {
          type: "string",
          enum: ["manha", "tarde", "noite"],
          description: "Preferência de período do dia do paciente (opcional)",
        },
        dia: {
          type: "string",
          description:
            "Dia pedido pelo paciente. Aceita dia da semana (\"segunda\", \"sexta\"), \"hoje\", \"amanhã\" ou data (\"27/07\", \"2026-07-27\"). Passe SEMPRE que o paciente citar um dia (opcional)",
        },
        horaPreferida: {
          type: "string",
          description:
            "Horário pedido pelo paciente, no formato HH:MM. Ex.: \"16:30\" para 'às 16h30', \"22:00\" para 'pelas 22h'. NUNCA arredonde: 16h30 é \"16:30\" (opcional)",
        },
        medico: {
          type: "string",
          description: "Nome do profissional, se o paciente pediu um específico (opcional)",
        },
      },
      required: ["especialidade"],
    },
  },
  {
    name: "agendar",
    description:
      "Agenda a consulta em um horário (slotId) previamente listado. Requer paciente já identificado E uma confirmação explícita dele na última mensagem (\"sim\", \"pode agendar\"). Escolher um horário não é confirmar — a ferramenta recusa se o paciente ainda não tiver confirmado.",
    input_schema: {
      type: "object",
      properties: {
        slotId: { type: "string", description: "ID do horário vindo de listar_horarios" },
        paymentType: {
          type: "string",
          enum: [PaymentType.PARTICULAR, PaymentType.HEALTH_PLAN],
          description: "Forma de atendimento",
        },
        plano: { type: "string", description: "Nome do plano, se paymentType = HEALTH_PLAN" },
      },
      required: ["slotId"],
    },
  },
  {
    name: "listar_meus_agendamentos",
    description: "Lista os agendamentos futuros do paciente já identificado.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancelar",
    description: "Cancela um agendamento pelo appointmentId (obtido em listar_meus_agendamentos).",
    input_schema: {
      type: "object",
      properties: { appointmentId: { type: "string" } },
      required: ["appointmentId"],
    },
  },
  {
    name: "remarcar",
    description: "Remarca um agendamento para um novo horário (novoSlotId vindo de listar_horarios).",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string" },
        novoSlotId: { type: "string" },
      },
      required: ["appointmentId", "novoSlotId"],
    },
  },
];

/**
 * Ferramentas que ESTA clínica expõe ao Claude.
 *
 * Quando a clínica não trabalha com convênio, deixar `listar_convenios` e o
 * campo `paymentType: HEALTH_PLAN` no catálogo funciona como um convite para o
 * modelo perguntar sobre convênio — mesmo com o prompt mandando não perguntar.
 * A porta se fecha aqui, removendo o que não faz sentido.
 */
export function buildTools(tenant: ResolvedTenant): Anthropic.Tool[] {
  // Sinal desligado: a ferramenta some. Deixá-la à mesa é o mesmo convite que
  // `listar_convenios` era numa clínica sem convênio — o modelo oferece um
  // pagamento antecipado que a clínica não cobra.
  const cobraSinal = Boolean(tenant.config.payment?.pixEnabled && tenant.config.payment.chave);
  const base = cobraSinal ? TODAS : TODAS.filter((t) => t.name !== "enviar_pix");

  if (tenant.config.booking.askInsurance) return base;

  return base.filter((t) => t.name !== "listar_convenios").map((t) => {
    if (t.name !== "agendar") return t;
    return {
      ...t,
      input_schema: {
        type: "object",
        properties: {
          slotId: { type: "string", description: "ID do horário vindo de listar_horarios" },
        },
        required: ["slotId"],
      },
    };
  });
}

/** Executa uma ferramenta chamada pelo Claude, sempre no escopo do tenant. */
export async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
  ctx: ConversationContext,
): Promise<unknown> {
  const t = ctx.tenant;
  switch (name) {
    case "listar_especialidades":
      return scheduling.listSpecialties(t.id);
    case "listar_unidades":
      return scheduling.listUnits(t.id);
    case "listar_convenios":
      return scheduling.listInsurers(t.id);
    case "identificar_paciente": {
      const p = await scheduling.identificarPaciente(t.id, {
        nome: input.nome,
        cpf: input.cpf,
        phone: ctx.phone,
      });
      if ("patientId" in p) ctx.patientId = p.patientId;
      return p;
    }
    case "listar_horarios":
      return scheduling.listAvailableSlots(t, {
        especialidade: input.especialidade,
        unidade: input.unidade,
        plano: input.plano,
        periodo: input.periodo,
        dia: input.dia,
        horaPreferida: input.horaPreferida,
        medico: input.medico,
        pacienteId: ctx.patientId, // continuidade: mantém o profissional de sempre
      });

    case "listar_medicos":
      return scheduling.listDoctors(t, input.especialidade);

    case "entrar_fila_espera":
      if (!ctx.patientId) {
        return { erro: "Identifique o paciente (nome e CPF) antes de entrar na fila." };
      }
      return scheduling.entrarFilaEspera(t, ctx.patientId, input.especialidade, input.periodo);

    case "enviar_pix":
      return gerarPixDoSinal(t, input.appointmentId);

    case "chamar_atendente":
      ctx.handoffRequested = true;
      return {
        ok: true,
        instrucao:
          "Avise ao paciente, de forma acolhedora, que a recepção foi notificada e vai responder em instantes. Não continue o agendamento.",
      };
    case "agendar": {
      if (!ctx.patientId) return { erro: "Paciente ainda não identificado. Use identificar_paciente antes." };
      // Trava real: já aconteceu de o agente agendar enquanto o paciente ainda
      // fazia perguntas. Sem um "sim" claro na última fala dele, não agenda.
      if (!ehConfirmacao(ctx.ultimaMensagemPaciente)) {
        return {
          erro:
            "O paciente ainda NÃO confirmou. Faça um resumo curto (especialidade, profissional, dia e horário), " +
            "pergunte apenas \"Posso confirmar?\" e só chame agendar depois de um sim claro.",
        };
      }
      return scheduling.bookAppointment(
        t,
        ctx.patientId,
        input.slotId,
        t.config.booking.askInsurance ? (input.paymentType ?? PaymentType.PARTICULAR) : PaymentType.PARTICULAR,
        t.config.booking.askInsurance ? input.plano : undefined,
      );
    }
    case "listar_meus_agendamentos":
      if (!ctx.patientId) return { erro: "Paciente ainda não identificado." };
      return scheduling.listPatientAppointments(t, ctx.patientId);
    case "cancelar":
      return scheduling.cancelAppointment(t, input.appointmentId);
    case "remarcar":
      return scheduling.rescheduleAppointment(t, input.appointmentId, input.novoSlotId);
    default:
      return { erro: `Ferramenta desconhecida: ${name}` };
  }
}
