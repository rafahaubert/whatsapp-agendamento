import type Anthropic from "@anthropic-ai/sdk";
import type { ResolvedTenant } from "../db/tenantRepository.js";
import { PaymentType } from "../shared/enums.js";
import * as scheduling from "../domain/scheduling.js";

/**
 * Contexto que atravessa uma conversa. `patientId` é preenchido quando
 * identificar_paciente roda e é persistido no estado da Conversation, de modo
 * que agendar/cancelar não dependem do Claude "lembrar" o id.
 */
export interface ConversationContext {
  tenant: ResolvedTenant;
  phone: string;
  patientId?: string;
}

/** Definições das ferramentas expostas ao Claude (esquema JSON). */
export const tools: Anthropic.Tool[] = [
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
    name: "identificar_paciente",
    description:
      "Identifica ou cadastra o paciente pelo nome completo e CPF. Chame assim que tiver ambos.",
    input_schema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome completo do paciente" },
        cpf: { type: "string", description: "CPF (com ou sem pontuação)" },
      },
      required: ["nome", "cpf"],
    },
  },
  {
    name: "listar_horarios",
    description:
      "Busca horários livres de uma especialidade. Retorna no máximo o número de opções configurado pela clínica.",
    input_schema: {
      type: "object",
      properties: {
        especialidade: { type: "string", description: "Nome da especialidade" },
        unidade: { type: "string", description: "Nome da unidade (opcional)" },
        plano: {
          type: "string",
          description: "Nome do plano para filtrar médicos que o aceitam (opcional)",
        },
      },
      required: ["especialidade"],
    },
  },
  {
    name: "agendar",
    description:
      "Agenda a consulta em um horário (slotId) previamente listado. Requer paciente já identificado.",
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
      const p = await scheduling.findOrCreatePatient(t.id, {
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
      });
    case "agendar":
      if (!ctx.patientId) return { erro: "Paciente ainda não identificado. Use identificar_paciente antes." };
      return scheduling.bookAppointment(
        t,
        ctx.patientId,
        input.slotId,
        input.paymentType ?? PaymentType.PARTICULAR,
        input.plano,
      );
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
