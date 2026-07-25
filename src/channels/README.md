# channels/

Adaptadores de canal. Cada canal traduz mensagens externas para um formato
interno único (`IncomingMessage`) e sabe enviar respostas (`sendMessage`).

- `whatsapp/` — Meta Cloud API (verificação do webhook, parse do payload, envio).

Manter os canais isolados aqui permite, no futuro, plugar Telegram/Instagram
sem tocar no motor de conversa (`core/`).
