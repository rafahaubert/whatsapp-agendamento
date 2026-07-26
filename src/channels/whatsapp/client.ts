import { env } from "../../config/env.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enviar(phoneNumberId: string, corpo: Record<string, any>): Promise<void> {
  const res = await fetch(urlMensagens(phoneNumberId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...corpo }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Falha ao enviar WhatsApp (${res.status}): ${body}`);
  }
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
