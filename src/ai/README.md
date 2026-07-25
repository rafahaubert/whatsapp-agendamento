# ai/

Integração com a Anthropic (Claude). Responsável por:

- Montar o **system prompt** a partir da `TenantConfig` (persona da clínica).
- **Extrair dados** da fala do paciente (nome, CPF, especialidade, escolha de horário).
- Gerar respostas fluidas em português.
- Expor **tools** que o modelo pode chamar: `listarHorarios`, `agendar`,
  `cancelar`, `remarcar` (executadas em `domain/`).

Implementado na Fase 2.
