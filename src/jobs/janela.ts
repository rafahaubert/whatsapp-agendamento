/**
 * O que todo job de envio proativo precisa: saber se PODE falar agora e ler a
 * config da clínica sem reparsear o mesmo JSON a cada ciclo.
 *
 * Vive aqui porque lembretes e follow-up precisam das duas coisas idênticas —
 * duas cópias divergem no primeiro ajuste de horário.
 */
import type { TenantConfig } from "../config/types.js";

/** Janela de envio: nada sai antes das 8h nem depois das 20h no fuso da clínica. */
export const HORA_INICIO_ENVIO = 8;
export const HORA_FIM_ENVIO = 20;

/**
 * O horário atual está dentro da janela de envio da clínica?
 *
 * É o que impede o lembrete à meia-noite. O fuso é o da clínica, não o do
 * servidor: o mesmo instante é 20h em São Paulo e 23h em Lisboa.
 */
export function dentroDaJanelaDeEnvio(timezone: string, agora: Date): boolean {
  const hora = parseInt(
    agora.toLocaleString("pt-BR", { timeZone: timezone, hour: "numeric", hour12: false }),
    10,
  );
  return hora >= HORA_INICIO_ENVIO && hora < HORA_FIM_ENVIO;
}

/** Cache de configuração por tenant (evita reparsear JSON a cada execução). */
const configCache = new Map<string, { config: TenantConfig; ts: number }>();
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/** Obtém a config do tenant com cache em memória. `null` = JSON inválido. */
export function getTenantConfig(tenant: { id: string; config: string }): TenantConfig | null {
  const cached = configCache.get(tenant.id);
  const now = Date.now();
  if (cached && now - cached.ts < CONFIG_CACHE_TTL_MS) {
    return cached.config;
  }
  try {
    const parsed = JSON.parse(tenant.config) as TenantConfig;
    configCache.set(tenant.id, { config: parsed, ts: now });
    return parsed;
  } catch {
    return null;
  }
}

/** Só para testes: descarta o cache entre casos. */
export function limparCacheDeConfig(): void {
  configCache.clear();
}
