/**
 * Desfecho da consulta — fecha a conta da TAXA DE FALTA.
 *
 * A taxa de falta é o número que a clínica olha na hora de renovar o contrato, e
 * ela sai de `COMPLETED` e `NO_SHOW`. Só que marcar o desfecho dependia
 * inteiramente de a recepção clicar no painel: sem o clique, o agendamento
 * ficava `SCHEDULED` para sempre, o denominador ficava zerado e a métrica vinha
 * nula — justamente na clínica com menos disciplina de clicar, que é a que mais
 * precisa do produto.
 *
 * Duas frentes, nesta ordem:
 *
 * 1. PERGUNTAR ao paciente, algumas horas depois da consulta. É de graça: dentro
 *    da janela de 24h da Meta a mensagem é livre, sem template aprovado. Como a
 *    janela exige que o paciente tenha escrito nas últimas 24h, isso não alcança
 *    todo mundo — quem confirmou presença pelo lembrete na véspera já está fora.
 *    Por isso existe a frente 2.
 *
 * 2. PRESUMIR comparecimento no silêncio, depois de alguns dias. O que é
 *    presumido fica marcado (`outcomeAuto`), e o painel mostra em cima de quanto
 *    a taxa foi calculada — estimativa não vira fato só porque ninguém contestou.
 */
import { prisma } from "../db/client.js";
import { sendWhatsAppButtons } from "../channels/whatsapp/client.js";
import { logMessage } from "../db/conversationRepository.js";
import { AppointmentStatus } from "../shared/enums.js";
import { logger } from "../shared/logger.js";
import { mascararTelefone } from "../shared/pii.js";
import { dentroDaJanelaDeEnvio, getTenantConfig } from "./janela.js";

/** Status que ainda esperam um desfecho. */
const PENDENTES: string[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.RESCHEDULED,
];

/** Horas após o fim da consulta para perguntar, quando a clínica não configurou. */
export const HORAS_APOS_CONSULTA_PADRAO = 3;

/** Dias sem resposta até presumir comparecimento, quando a clínica não configurou. */
export const DIAS_PARA_PRESUMIR_PADRAO = 3;

/**
 * Teto da janela de 24h da Meta, com margem — igual ao do follow-up.
 *
 * Passou disso, mensagem livre é recusada e só um template entraria, o que
 * anularia a graça de perguntar. A margem protege contra cron atrasado.
 */
const LIMITE_JANELA_META_MS = 20 * 60 * 60 * 1000;

export interface ConsultaSemDesfecho {
  id: string;
  status: string;
  /** Fim da consulta. */
  endsAt: Date;
  outcomeAskedAt: Date | null;
  /** Última vez que o paciente escreveu — define se a mensagem livre passa. */
  ultimaMensagemPaciente: Date | null;
}

/**
 * Regra pura (testável): dá para PERGUNTAR a este paciente agora?
 *
 * Elegível = consulta já terminou há `horasApos`, ainda sem desfecho, ninguém
 * perguntou ainda, e o paciente escreveu dentro da janela da Meta (senão a
 * mensagem livre é recusada e a pergunta custaria um template).
 */
export function podePerguntar(
  consulta: ConsultaSemDesfecho,
  agora: Date,
  horasApos: number = HORAS_APOS_CONSULTA_PADRAO,
): boolean {
  if (consulta.outcomeAskedAt !== null) return false;
  if (!PENDENTES.includes(consulta.status)) return false;

  const terminouHa = agora.getTime() - consulta.endsAt.getTime();
  if (terminouHa < horasApos * 3_600_000) return false;

  if (!consulta.ultimaMensagemPaciente) return false;
  return agora.getTime() - consulta.ultimaMensagemPaciente.getTime() < LIMITE_JANELA_META_MS;
}

/**
 * Regra pura (testável): já dá para PRESUMIR comparecimento?
 *
 * Só depois de o silêncio ser longo o bastante para significar alguma coisa. Com
 * `dias = 0` a clínica desliga a presunção e fica só com o que for confirmado.
 */
export function devePresumir(
  consulta: ConsultaSemDesfecho,
  agora: Date,
  dias: number = DIAS_PARA_PRESUMIR_PADRAO,
): boolean {
  if (dias <= 0) return false;
  if (!PENDENTES.includes(consulta.status)) return false;
  return agora.getTime() - consulta.endsAt.getTime() >= dias * 86_400_000;
}

/** A pergunta: curta, sem cobrança, e resolvida num toque. */
const PERGUNTA = "Oi! Você conseguiu vir à consulta? 🙂";

export async function apurarDesfechos(
  agora = new Date(),
): Promise<{ perguntados: number; presumidos: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let perguntados = 0;
  let presumidos = 0;

  for (const tenant of tenants) {
    const config = getTenantConfig(tenant);
    const cfg = config?.outcome;
    if (!cfg?.enabled) continue;

    const horasApos = cfg.horasAposConsulta ?? HORAS_APOS_CONSULTA_PADRAO;
    const dias = cfg.diasParaPresumir ?? DIAS_PARA_PRESUMIR_PADRAO;

    // A presunção é escrita no banco, não manda mensagem: roda a qualquer hora.
    if (dias > 0) {
      const limite = new Date(agora.getTime() - dias * 86_400_000);
      const { count } = await prisma.appointment.updateMany({
        where: {
          tenantId: tenant.id,
          status: { in: PENDENTES },
          slot: { endsAt: { lte: limite } },
        },
        data: { status: AppointmentStatus.COMPLETED, outcomeAuto: true },
      });
      presumidos += count;
      if (count) {
        logger.info({ tenant: tenant.slug, count }, "desfechos presumidos por falta de resposta");
      }
    }

    // Perguntar é mandar mensagem: vale a janela de envio da clínica.
    if (!dentroDaJanelaDeEnvio(tenant.timezone, agora)) continue;

    const desdeQuando = new Date(agora.getTime() - horasApos * 3_600_000);
    const candidatos = await prisma.appointment.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: PENDENTES },
        outcomeAskedAt: null,
        slot: { endsAt: { lte: desdeQuando } },
      },
      include: { patient: true, slot: true },
      take: 200,
      orderBy: { slot: { endsAt: "asc" } },
    });

    for (const appt of candidatos) {
      // A janela da Meta depende de quando o paciente escreveu pela última vez.
      const ultima = await prisma.message.findFirst({
        where: { tenantId: tenant.id, phone: appt.patient.phone, direction: "IN" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });

      const elegivel = podePerguntar(
        {
          id: appt.id,
          status: appt.status,
          endsAt: appt.slot.endsAt,
          outcomeAskedAt: appt.outcomeAskedAt,
          ultimaMensagemPaciente: ultima?.createdAt ?? null,
        },
        agora,
        horasApos,
      );
      if (!elegivel) continue;

      try {
        await sendWhatsAppButtons(tenant.whatsappPhoneNumberId, appt.patient.phone, PERGUNTA, [
          { id: `VEIO:${appt.id}`, titulo: "Sim, fui" },
          { id: `FALTEI:${appt.id}`, titulo: "Não consegui" },
        ]);

        // A marca vai DEPOIS do envio: se o processo cair no meio, o pior caso é
        // perguntar de novo no ciclo seguinte — nunca uma consulta marcada como
        // perguntada sem que o paciente tenha recebido nada.
        await prisma.appointment.update({
          where: { id: appt.id },
          data: { outcomeAskedAt: new Date() },
        });

        // Entra na caixa de entrada do painel como qualquer fala do bot: a
        // recepção precisa ver que o sistema falou.
        await logMessage(tenant.id, appt.patient.phone, "OUT", PERGUNTA, "BOT");
        perguntados++;
      } catch (err) {
        logger.error(
          { err, tenant: tenant.slug, to: mascararTelefone(appt.patient.phone) },
          "falha ao perguntar o desfecho da consulta",
        );
      }
    }
  }

  if (perguntados || presumidos) {
    logger.info({ perguntados, presumidos }, "desfechos apurados");
  }
  return { perguntados, presumidos };
}
