# Integração com Google Calendar

Sincronização **de uma via**: quando um paciente **agenda / cancela / remarca** pelo
WhatsApp, o evento é **criado / removido / atualizado** no Google Calendar do dentista.

A conexão usa uma **conta de serviço** (sem login por usuário): o dentista compartilha
o calendário dele com o e-mail da conta de serviço. Se a chave não estiver configurada,
tudo funciona normalmente — a sync fica apenas **desligada**.

## 1. Criar a conta de serviço (uma vez)

1. Acesse o **Google Cloud Console** → crie (ou escolha) um projeto.
2. **APIs e serviços → Biblioteca** → habilite a **Google Calendar API**.
3. **APIs e serviços → Credenciais → Criar credenciais → Conta de serviço** → dê um nome
   (ex.: `agente-whatsapp`) → concluir.
4. Abra a conta de serviço → aba **Chaves → Adicionar chave → Criar nova chave → JSON** →
   baixe o arquivo `.json`.

## 2. Configurar a chave no Render

- Abra o JSON baixado, copie **todo o conteúdo em uma única linha** e cole na variável de
  ambiente **`GOOGLE_SERVICE_ACCOUNT_KEY`** (no Render → Environment).
- O `private_key` contém `\n` — isso é normal, mantenha como está no JSON.

## 3. Compartilhar o calendário de cada dentista

No painel (`/admin`), na seção **Médicos** de cada clínica, aparecerá o **e-mail da conta
de serviço** (algo como `...@...iam.gserviceaccount.com`). Para cada dentista:

1. No **Google Calendar** do dentista → engrenagem do calendário → **Configurações e
   compartilhamento**.
2. Em **Compartilhar com pessoas e grupos específicos** → **Adicionar pessoas** → cole o
   e-mail da conta de serviço → permissão **"Fazer alterações nos eventos"**.
3. Em **Integrar agenda**, copie o **ID da agenda** (ex.: `abc123@group.calendar.google.com`;
   para a agenda principal, é o próprio e-mail da conta Google).
4. No painel, cole esse **Calendar ID** no campo do dentista e salve.

Pronto. A partir daí, os agendamentos daquele dentista aparecem no Google Calendar dele.

## Observações

- **Segurança:** `GOOGLE_SERVICE_ACCOUNT_KEY` é um segredo — só no ambiente do provedor,
  nunca no repositório.
- **Fuso:** os eventos são criados no fuso da clínica (`America/Sao_Paulo` por padrão).
- **Resiliência:** falha no Google **nunca** quebra o agendamento — o registro no nosso
  banco é a fonte da verdade; erros são apenas logados.
- **Escopo atual:** uma via (nós → Google). Ler a agenda do Google para bloquear horários
  ocupados (duas vias) pode ser adicionado depois.
