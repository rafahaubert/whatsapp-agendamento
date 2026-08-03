# Lembrete de consulta — template do WhatsApp

O lembrete automático é uma **mensagem iniciada pela empresa**. A Meta só permite isso
com um **template aprovado** e um **método de pagamento** na conta. Este guia cobre os
dois passos e como ligar o recurso no painel.

> Sem isso, o resto do sistema funciona normalmente — apenas o lembrete não é enviado.

## 1. Método de pagamento (uma vez)

`business.facebook.com` → **Configurações do WhatsApp Manager** → **Faturamento** →
adicione um cartão. (Também aparece como a etapa *"Adicione informações de pagamento para
enviar mensagens iniciadas pela empresa"* no app de desenvolvedor.)

A Meta cobra por **conversa iniciada pela empresa** — confirme os valores atuais no painel
da própria Meta.

## 2. Criar o template

**WhatsApp Manager** → **Modelos de mensagem** → **Criar modelo**:

| Campo | Valor |
|---|---|
| Categoria | **Utilidade** (não Marketing — é aviso de serviço) |
| Nome | `lembrete_consulta` |
| Idioma | **Português (BR)** |

**Corpo** (as variáveis são preenchidas pelo sistema, nesta ordem):

```
Olá, {{1}}! Passando para lembrar da sua consulta.

🗓️ {{2}}
👨‍⚕️ {{3}}
📍 {{4}}

Podemos confirmar sua presença?
```

**Botões** → tipo **Resposta rápida**, exatamente **nesta ordem**:

1. `Confirmar`
2. `Remarcar`
3. `Cancelar`

> ⚠️ A **ordem importa**: o sistema envia os payloads `CONFIRMAR:…`, `REMARCAR:…` e
> `CANCELAR:…` conforme a posição (0, 1, 2). Trocar a ordem troca as ações.

Envie para aprovação — costuma levar de minutos a algumas horas.

## 3. Ligar no painel

Painel → clínica → seção **Lembrete de consulta**:

- ✅ **Ativar lembretes**
- **Horas de antecedência**: `24` (recomendado; pode usar `48` ou `3`)
- **Carência após agendar (horas)**: `6` (recomendado) — ver abaixo
- **Nome do template**: `lembrete_consulta` (igual ao aprovado)
- **Idioma do template**: `pt_BR`

Salve a configuração.

> **Por que a carência existe.** Sem ela, quem marca hoje para amanhã cai na janela de 24h
> no mesmo instante e recebe o lembrete no ciclo seguinte de 10 minutos — ou seja, paga-se um
> template à Meta para lembrar o paciente de algo que ele acabou de fazer. Com `6`, só é
> lembrado quem agendou há pelo menos seis horas. Quem marca uma urgência para daqui a pouco
> simplesmente não recebe lembrete, que é o certo. Use `0` para voltar ao comportamento antigo.

## 4. Como o envio acontece

- O servidor verifica a cada **10 minutos** quem tem consulta dentro da janela configurada.
- Envia **uma vez por agendamento** (grava `reminderSentAt`; nunca duplica).
- Ao clicar num botão, o sistema age **na hora**, sem passar pela IA:
  - **Confirmar** → status vira *Confirmado* (aparece no painel e no calendário)
  - **Cancelar** → cancela e **libera o horário** para outro paciente
  - **Remarcar** → o agente assume e oferece novos horários

### Garantia de execução (plano gratuito)

No plano free o serviço hiberna e o timer interno pode não rodar no horário. Configure um
**cron externo** chamando o endpoint protegido:

```
POST https://SEU-APP.onrender.com/jobs/run
Header: x-jobs-token: <valor de JOBS_TOKEN>
```

> `/jobs/run` executa **lembretes + renovação da agenda** (recomendado).
> `/jobs/reminders` continua existindo e roda só os lembretes.

Defina `JOBS_TOKEN` nas variáveis de ambiente e agende no
[cron-job.org](https://cron-job.org) (gratuito) a cada 15 minutos.

## 5. Testar

1. Crie um agendamento manual no painel para **daqui a ~23 horas** (com o seu WhatsApp).
2. Chame o endpoint acima (ou espere o ciclo de 10 min).
3. Você deve receber o lembrete com os 3 botões → clique em **Confirmar** → o status muda
   para *Confirmado* no painel.

---

# Outros dois templates (opcionais)

Mesmo processo do lembrete: **Utilidade**, Português (BR), e o nome exato preenchido no painel.

## `vaga_disponivel` — fila de espera

Enviado quando alguém cancela e há paciente esperando. Converte o buraco na agenda em receita.

**Corpo:**

```
Boa notícia, {{1}}! Vagou um horário na nossa agenda.

🗓️ {{2}}
👨‍⚕️ {{3}}
📍 {{4}}

Quer garantir esse horário?
```

**Botão** (resposta rápida, apenas **um**): `Quero esse horário`

> Ao tocar no botão, o sistema já sabe qual horário é — o agente segue direto para a
> confirmação.

**O horário fica reservado para quem foi avisado por 30 minutos.** Nesse intervalo ele some
da lista oferecida aos outros pacientes e continua visível só para o convidado — sem isso o
convite não valia nada, porque qualquer um podia levar o horário antes de a mensagem ser lida.

**Se o convidado não responder, a vez passa ao próximo.** Vencidos os 30 minutos, o horário é
solto e o segundo da fila recebe o convite. Quem deixa passar três convites sai da fila: não
está esperando de verdade, e mantê-lo na frente atrasaria todo mundo atrás. Quem consegue a
consulta sai da fila automaticamente.

Ative em **Fila de espera** na configuração da clínica.

## `retorno_consulta` — reativação de pacientes

Convida de volta quem não aparece há alguns meses (limpeza semestral, retorno).

> ⚠️ **Este é o único que a Meta cobra como Marketing, não como Utilidade.** Convite de
> retorno é reengajamento, e a Meta reclassifica sozinha se você enviar como Utilidade —
> a diferença é de cerca de R$ 0,04 para R$ 0,34 por mensagem. Crie-o já na categoria
> **Marketing** e trate o custo como tal: mil convites custam ~R$ 340, não ~R$ 40.

**Corpo:**

```
Olá, {{1}}! Faz um tempinho desde a sua última consulta na {{2}}.

Que tal agendar uma avaliação? É só responder esta mensagem que eu cuido do resto. 😊
```

Sem botões. Ative em **Reativação de pacientes**, definindo os meses (padrão: 6).
Cada paciente recebe no máximo **um convite a cada 90 dias**.

---

## A automação que NÃO precisa de template: follow-up de conversa parada

O paciente começa a agendar e some no meio ("qual seu nome completo?" e silêncio). Meia
hora depois o sistema manda **uma** mensagem retomando a conversa.

Como a última mensagem dele foi há poucos minutos, isso acontece **dentro da janela de
24h** — e dentro dela a resposta é texto livre. Sem template, sem aprovação na Meta e
sem o custo por template dos outros três. É a automação mais barata do sistema.

Regras embutidas, para não virar perseguição:

- **Uma só por conversa**, nunca repete (marca `followUpSentAt`).
- Nunca cutuca quem **já agendou** — silêncio depois do agendamento é conversa que deu certo.
- Nunca cutuca conversa em **atendimento humano**: quando a recepção assume, o bot é mudo.
- Nunca cutuca quando quem falou por último foi o **paciente** — se ele ficou sem resposta,
  o problema é outro, e um "quer seguir?" por cima seria constrangedor.
- Respeita a janela de **8h às 20h** no fuso da clínica.
- Desiste depois de **20h de silêncio**: aí a janela da Meta está acabando e só um template
  passaria.

Ative em **Follow-up de conversa parada** na página de automações, ajustando os minutos de
silêncio (padrão: 30) e, se quiser, o texto.

## A outra automação sem template: desfecho da consulta

A **taxa de falta** é o número que a clínica olha na hora de renovar o contrato — e ela só
fecha quando cada consulta passada tem um desfecho (*compareceu* ou *faltou*). Isso dependia
inteiramente de alguém clicar no painel: sem o clique, o agendamento ficava *Agendado* para
sempre e a métrica aparecia vazia, justamente na clínica com menos disciplina de clicar.

Com a apuração ligada, o sistema trabalha em duas frentes:

1. **Pergunta ao próprio paciente**, algumas horas depois da consulta, com dois botões
   (*Sim, fui* / *Não consegui*). É de graça: dentro da janela de 24h a mensagem é livre.
   Como a janela exige que ele tenha escrito recentemente, isso não alcança todo mundo — daí
   a segunda frente.
2. **Presume comparecimento** depois de alguns dias de silêncio.

O que for presumido fica **marcado como estimativa**, e o painel mostra quantos desfechos são
presunção ao lado da taxa. Isso importa: a presunção puxa a taxa de falta para baixo, e
apresentá-la como número apurado seria enganar a clínica. Quem prefere um número menor porém
firme põe **Dias até presumir comparecimento** em `0` — aí só conta o que for confirmado.

Ative em **Desfecho da consulta** na página de automações.

---

## Observações

- **Janela de 24h**: fora dela, só é possível iniciar conversa por template — vale também
  para respostas manuais pela caixa de entrada.
- Se o template for **reprovado**, ajuste o texto (evite tom promocional) e reenvie.
- O nome do template no painel precisa ser **idêntico** ao aprovado, incluindo o idioma.
