/**
 * Reativação de pacientes (recall).
 *
 * Convida de volta quem não aparece há alguns meses — em odontologia é o que
 * traz receita "adormecida" (limpeza semestral, retorno de tratamento).
 * Idempotente: grava `lastRecallAt` e respeita um intervalo mínimo entre convites.
 */
import { prisma } from "../db/client.js";
import { sendWhatsAppTemplate } from "../channels/whatsapp/client.js";
import { logger } from "../shared/logger.js";
import type { TenantConfig } from "../config/types.js";

/** Não convidar o mesmo paciente com menos de 90 dias de intervalo. */
const INTERVALO_MINIMO_DIAS = 90;

export interface PacienteRecall {
  id: string;
  ultimaConsulta: Date | null;
  lastRecallAt: Date | null;
}

/**
 * Regra pura (testável): quem deve receber o convite de retorno agora.
 * Elegível = já foi atendido alguma vez, a última consulta passou de `meses`
 * e não recebeu convite recente.
 */
export function selecionarParaRecall<T extends PacienteRecall>(
  pacientes: T[],
  agora: Date,
  meses: number,
): T[] {
  const limite = new Date(agora);
  limite.setMonth(limite.getMonth() - meses);
  const minimo = new Date(agora.getTime() - INTERVALO_MINIMO_DIAS * 86_400_000);

  return pacientes.filter(
    (p) =>
      p.ultimaConsulta !== null &&
      p.ultimaConsulta <= limite &&
      (p.lastRecallAt === null || p.lastRecallAt <= minimo),
  );
}

export async function enviarReativacoes(agora = new Date()): Promise<{ enviados: number }> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  let enviados = 0;

  for (const tenant of tenants) {
    let config: TenantConfig;
    try {
      config = JSON.parse(tenant.config) as TenantConfig;
    } catch {
      continue;
    }

    const cfg = config.recall;
    if (!cfg?.enabled || !cfg.templateName) continue;

    // Pacientes da clínica com a data da última consulta.
    const pacientes = await prisma.patient.findMany({
      where: { tenantId: tenant.id },
      select: {
        id: true,
        name: true,
        phone: true,
        lastRecallAt: true,
        appointments: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { slot: { select: { startsAt: true } } },
        },
      },
      take: 500,
    });

    const candidatos = selecionarParaRecall(
      pacientes.map((p) => ({
        ...p,
        ultimaConsulta: p.appointments[0]?.slot.startsAt ?? null,
      })),
      agora,
      cfg.months || 6,
    );

    for (const paciente of candidatos) {
      try {
        await sendWhatsAppTemplate(tenant.whatsappPhoneNumberId, paciente.phone, {
          name: cfg.templateName,
          lang: cfg.templateLang || "pt_BR",
          // {{1}} paciente · {{2}} nome da clínica
          bodyParams: [paciente.name, config.branding.clinicName || tenant.name],
        });
        await prisma.patient.update({
          where: { id: paciente.id },
          data: { lastRecallAt: new Date() },
        });
        enviados++;
      } catch (err) {
        logger.error({ err, patientId: paciente.id }, "falha ao enviar reativação");
      }
    }
  }

  if (enviados) logger.info({ enviados }, "convites de retorno enviados");
  return { enviados };
}
