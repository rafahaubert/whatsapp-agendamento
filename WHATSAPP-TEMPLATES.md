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

> ⚠️ A **ordem importa**: a API da Meta endereça botão por posição (0, 1, 2), não
> pelo rótulo. Se o seu template ficou em outra ordem, o payload `CONFIRMAR:` cai
> no botão escrito "Cancelar" — e o paciente que toca em "Cancelar" confirma a
> consulta.
>
> **Cadastrou em outra ordem?** Não precisa refazer o template: declare a ordem
> real na configuração da clínica, em `reminders.botoes`. Exemplo para um
> template cadastrado como Cancelar / Remarcar / Confirmar:
>
> ```json
> "reminders": {
>   "enabled": true,
>   "hoursBefore": 24,
>   "templateName": "lembrete_consulta",
>   "templateLang": "pt_BR",
>   "botoes": ["CANCELAR", "REMARCAR", "CONFIRMAR"]
> }
> ```
>
> Omitir o campo mantém a ordem acima (Confirmar / Remarcar / Cancelar). Uma
> ordem inválida — ação repetida, faltando ou desconhecida — é ignorada em favor
> do padrão, com um erro no log.

Envie para aprovação — costuma levar de minutos a algumas horas.

## 3. Ligar no painel

Painel → clínica → seção **Lembrete de consulta**:

- ✅ **Ativar lembretes**
- **Horas de antecedência**: `24` (recomendado; pode usar `48` ou `3`)
- **Nome do template**: `lembrete_consulta` (igual ao aprovado)
- **Idioma do template**: `pt_BR`

Salve a configuração.

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
> confirmação. Se outra pessoa pegar antes, ele avisa e oferece alternativas.

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

## Observações

- **Janela de 24h**: fora dela, só é possível iniciar conversa por template — vale também
  para respostas manuais pela caixa de entrada.
- Se o template for **reprovado**, ajuste o texto (evite tom promocional) e reenvie.
- O nome do template no painel precisa ser **idêntico** ao aprovado, incluindo o idioma.
