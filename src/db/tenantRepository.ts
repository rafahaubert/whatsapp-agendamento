import { prisma } from "./client.js";
import type { TenantConfig } from "../config/types.js";
import { logger } from "../shared/logger.js";

/**
 * Desserializa a config sem derrubar quem chamou.
 *
 * O `JSON.parse` direto rodava dentro do laço do webhook: uma config corrompida
 * numa clínica estourava o lote inteiro, levando junto as mensagens das outras.
 * Devolver `null` transforma isso em "clínica não resolvida" — o webhook ignora
 * aquela mensagem e segue com o resto.
 */
function lerConfig(slug: string, bruto: string): TenantConfig | null {
  try {
    return JSON.parse(bruto) as TenantConfig;
  } catch (err) {
    logger.error({ err, tenant: slug }, "config da clínica não é um JSON válido");
    return null;
  }
}

/** Tenant já resolvido, com a `config` desserializada de String → objeto. */
export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  whatsappPhoneNumberId: string;
  config: TenantConfig;
}

/** Carrega um tenant pelo id, já com a config desserializada. */
export async function findTenantById(id: string): Promise<ResolvedTenant | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) return null;
  const config = lerConfig(tenant.slug, tenant.config);
  if (!config) return null;
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    timezone: tenant.timezone,
    whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
    config,
  };
}

/**
 * Coração do roteamento multi-tenant: dado o número que RECEBEU a mensagem
 * (phone_number_id da Meta), descobre a qual clínica ela pertence.
 */
export async function findTenantByPhoneNumberId(
  phoneNumberId: string,
): Promise<ResolvedTenant | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { whatsappPhoneNumberId: phoneNumberId },
  });

  if (!tenant || !tenant.isActive) return null;

  const config = lerConfig(tenant.slug, tenant.config);
  if (!config) return null;

  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    timezone: tenant.timezone,
    whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
    config,
  };
}
