import { prisma } from "./client.js";
import type { TenantConfig } from "../config/types.js";

/** Tenant já resolvido, com a `config` desserializada de String → objeto. */
export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  whatsappPhoneNumberId: string;
  config: TenantConfig;
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

  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    timezone: tenant.timezone,
    whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
    config: JSON.parse(tenant.config) as TenantConfig,
  };
}
