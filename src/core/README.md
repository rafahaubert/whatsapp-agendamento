# core/

Motor de conversa. Orquestra o fluxo:

1. Recebe `IncomingMessage` de um canal.
2. Resolve o **tenant** (pelo `phone_number_id`).
3. Carrega/atualiza a `Conversation` (estado + memória).
4. Aplica a máquina de estados (saudação → nome → CPF → especialidade →
   horários → confirmação) apoiada pela IA (`ai/`).
5. Chama as regras de negócio (`domain/`) e devolve a resposta ao canal.

Implementado na Fase 2.
