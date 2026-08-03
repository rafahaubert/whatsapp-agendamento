import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

/**
 * Quanto esperar a Graph API antes de desistir de UMA tentativa.
 *
 * Sem isto o `fetch` não tem prazo: um POST pendurado na Meta trava a conversa
 * inteira, porque src/core/inbox.ts executa uma conversa de cada vez. O
 * paciente ficava sem resposta e sem erro no log.
 */
const TIMEOUT_MS = 15_000;

/** Tentativas totais (a primeira mais duas repetições). */
const MAX_TENTATIVAS = 3;

/** Espera base do backoff exponencial: 500ms, 1s, 2s… */
const BACKOFF_BASE_MS = 500;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Vale repetir este status?
 *
 * Só o que é transitório: 429 (limite) e 5xx (falha do lado da Meta). Um 400
 * ("template rejeitado", "número inválido") repetido três vezes é o mesmo erro
 * três vezes, gastando quota e atrasando a fila.
 */
export function valeRepetir(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Quanto esperar antes da próxima tentativa.
 * `retry-after` da Meta manda; sem ele, backoff exponencial.
 */
export function esperaAntesDeRepetir(tentativa: number, retryAfter: string | null): number {
  const segundos = Number(retryAfter);
  if (retryAfter && Number.isFinite(segundos) && segundos >= 0) {
    return Math.min(segundos * 1000, 30_000);
  }
  return BACKOFF_BASE_MS * 2 ** tentativa;
}

/** Opção oferecida ao paciente (vira botão ou item de lista). */
export interface OpcaoWhatsApp {
  /** Volta como `payload` quando o paciente escolhe. Máx. 200 caracteres. */
  id: string;
  /** Rótulo. Máx. 24 caracteres (lista) / 20 (botão) — cortado automaticamente. */
  titulo: string;
  /** Detalhe secundário (só em lista). Máx. 72 caracteres. */
  descricao?: string;
}

function urlMensagens(phoneNumberId: string): string {
  return `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;
}

/**
 * Envia à Graph API com prazo e repetição do que é transitório.
 *
 * A falha que isto resolve não é rara: um 500 momentâneo da Meta significava o
 * paciente simplesmente não receber resposta, sem nada a fazer a respeito.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enviar(phoneNumberId: string, corpo: Record<string, any>): Promise<void> {
  const payload = JSON.stringify({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...corpo,
  });

  let ultimoErro: unknown;

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    const ultima = tentativa === MAX_TENTATIVAS - 1;
    let res: Response;

    try {
      res = await fetch(urlMensagens(phoneNumberId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout ou queda de rede: transitório por natureza.
      ultimoErro = err;
      if (ultima) break;
      const espera = esperaAntesDeRepetir(tentativa, null);
      logger.warn({ err, tentativa: tentativa + 1, espera }, "rede falhou ao enviar WhatsApp — repetindo");
      await dormir(espera);
      continue;
    }

    if (res.ok) return;

    const body = await res.text().catch(() => "");
    const erro = new Error(`Falha ao enviar WhatsApp (${res.status}): ${body}`);

    // Erro definitivo (template rejeitado, número inválido, token vencido):
    // sobe na hora. Repetir três vezes é o mesmo erro três vezes, gastando
    // quota e atrasando a fila.
    if (!valeRepetir(res.status)) throw erro;

    ultimoErro = erro;
    if (ultima) break;
    const espera = esperaAntesDeRepetir(tentativa, res.headers.get("retry-after"));
    logger.warn(
      { status: res.status, tentativa: tentativa + 1, espera },
      "envio ao WhatsApp falhou — repetindo",
    );
    await dormir(espera);
  }

  throw ultimoErro instanceof Error
    ? ultimoErro
    : new Error(`Falha ao enviar WhatsApp após ${MAX_TENTATIVAS} tentativas`);
}

const corta = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * A Meta rejeita botões/itens com títulos repetidos ("Duplicate button title").
 * Como o corte por tamanho também pode gerar repetição, garantimos unicidade
 * acrescentando um sufixo numérico.
 */
export function titulosUnicos(opcoes: OpcaoWhatsApp[], max: number): OpcaoWhatsApp[] {
  const usados = new Set<string>();
  return opcoes.map((o) => {
    let titulo = corta(o.titulo, max);
    let n = 2;
    while (usados.has(titulo)) {
      const sufixo = ` (${n})`;
      titulo = corta(o.titulo, max - sufixo.length) + sufixo;
      n++;
    }
    usados.add(titulo);
    return { ...o, titulo };
  });
}

/**
 * Envia uma mensagem de texto pela Cloud API.
 * O `phoneNumberId` vem do tenant, então a MESMA credencial global pode enviar
 * a partir de números diferentes (multi-clínica).
 */
export async function sendWhatsAppText(
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<void> {
  await enviar(phoneNumberId, { to, type: "text", text: { preview_url: false, body: text } });
}

/**
 * Envia botões de resposta rápida (máx. 3). Bom para poucas ações
 * (ex.: Confirmar / Remarcar / Cancelar).
 */
export async function sendWhatsAppButtons(
  phoneNumberId: string,
  to: string,
  texto: string,
  opcoes: OpcaoWhatsApp[],
): Promise<void> {
  await enviar(phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: corta(texto, 1024) },
      action: {
        buttons: titulosUnicos(opcoes.slice(0, 3), 20).map((o) => ({
          type: "reply",
          reply: { id: corta(o.id, 200), title: o.titulo },
        })),
      },
    },
  });
}

/**
 * Envia uma lista interativa (máx. 10 itens). Melhor que botões quando há
 * várias opções — usamos para os horários disponíveis.
 */
export async function sendWhatsAppList(
  phoneNumberId: string,
  to: string,
  texto: string,
  opcoes: OpcaoWhatsApp[],
  rotuloBotao = "Ver horários",
): Promise<void> {
  await enviar(phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: corta(texto, 1024) },
      action: {
        button: corta(rotuloBotao, 20),
        sections: [
          {
            title: "Opções",
            rows: titulosUnicos(opcoes.slice(0, 10), 24).map((o) => ({
              id: corta(o.id, 200),
              title: o.titulo,
              ...(o.descricao ? { description: corta(o.descricao, 72) } : {}),
            })),
          },
        ],
      },
    },
  });
}

/**
 * Envia um TEMPLATE aprovado na Meta — único jeito de iniciar conversa
 * (ex.: lembrete de consulta) fora da janela de 24h.
 *
 * `bodyParams` preenche as variáveis {{1}}, {{2}}… do corpo, na ordem.
 * `buttonPayloads` define o payload de cada botão de resposta rápida do template.
 */
export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  to: string,
  opts: { name: string; lang?: string; bodyParams?: string[]; buttonPayloads?: string[] },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const components: Record<string, any>[] = [];

  if (opts.bodyParams?.length) {
    components.push({
      type: "body",
      parameters: opts.bodyParams.map((t) => ({ type: "text", text: t })),
    });
  }

  opts.buttonPayloads?.forEach((payload, i) => {
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(i),
      parameters: [{ type: "payload", payload: corta(payload, 128) }],
    });
  });

  await enviar(phoneNumberId, {
    to,
    type: "template",
    template: {
      name: opts.name,
      language: { code: opts.lang ?? "pt_BR" },
      ...(components.length ? { components } : {}),
    },
  });
}
