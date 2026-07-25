# domain/

Regras de negócio puras (sem depender de WhatsApp nem de IA):

- `scheduling` — buscar horários livres, agendar, cancelar, remarcar.
- `patients` — localizar/criar paciente por CPF (dentro do tenant).

Recebe/retorna tipos do domínio; fácil de testar em isolamento.
Implementado na Fase 3.
