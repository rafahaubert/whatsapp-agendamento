/**
 * Tipagem mínima do payload de webhook da Meta Cloud API.
 * Documentação: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */
export interface WhatsAppWebhookBody {
  object: string;
  entry?: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id: string;
  changes?: WhatsAppChange[];
}

export interface WhatsAppChange {
  field: string;
  value: WhatsAppValue;
}

export interface WhatsAppValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string; // ← chave de roteamento do tenant
  };
  contacts?: { profile: { name: string }; wa_id: string }[];
  messages?: WhatsAppMessage[];
  statuses?: unknown[]; // recibos de entrega/leitura — ignorados na Fase 1
}

export interface WhatsAppMessage {
  from: string; // telefone do paciente
  id: string;
  timestamp: string; // epoch em segundos (string)
  type: string; // "text" | "audio" | "button" | "interactive" | "image" | ...
  text?: { body: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  /** Resposta a um botão de TEMPLATE (quick reply). */
  button?: { payload?: string; text?: string };
  /** Resposta a mensagem interativa (botões ou lista) enviada por nós. */
  interactive?: {
    type?: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
}
