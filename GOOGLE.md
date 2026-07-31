# Integração com Google Calendar

**Escrita:** quando um paciente **agenda / cancela / remarca** pelo WhatsApp, o evento é
**criado / removido / atualizado** no Google Calendar do dentista.

**Leitura:** antes de confirmar um agendamento ou remarcação, o sistema consulta a
disponibilidade (`freebusy`) no calendário do dentista. Se o horário já estiver ocupado
lá, a marcação é recusada e o paciente é convidado a escolher outro. É isso que impede o
agente de marcar consulta por cima de férias, cirurgia ou compromisso pessoal que o
dentista bloqueou direto no Google.

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
  banco é a fonte da verdade; erros são apenas logados. A checagem de disponibilidade
  segue a mesma regra: se o Google não responder em 4 s, ou o calendário não estiver
  compartilhado com a conta de serviço, o agendamento **prossegue** (o log registra que
  não deu para checar). Indisponibilidade do Google não pode parar o atendimento.
- **Permissão necessária:** a leitura exige que o calendário esteja compartilhado com a
  conta de serviço — o mesmo passo 3 acima já resolve. Sem isso, o Google devolve erro por
  calendário e a checagem é ignorada; procure `o calendário está compartilhado?` no log.
- **Limitação conhecida:** a checagem acontece na **confirmação**, não na listagem de
  horários. Oferecer opções faz uma consulta ao banco a cada mensagem, e chamar o Google
  aí dentro somaria latência a toda a conversa. Na prática o paciente pode ver um horário
  que o dentista bloqueou no Google e receber a recusa só ao confirmar.
- **Janela residual:** entre a checagem e a gravação existem alguns milissegundos em que
  um evento novo no Google passaria despercebido. Fechar isso exigiria o Google como fonte
  da verdade transacional, o que ele não é.
