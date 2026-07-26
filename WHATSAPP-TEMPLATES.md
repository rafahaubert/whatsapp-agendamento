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

## Observações

- **Janela de 24h**: fora dela, só é possível iniciar conversa por template — vale também
  para respostas manuais pela caixa de entrada.
- Se o template for **reprovado**, ajuste o texto (evite tom promocional) e reenvie.
- O nome do template no painel precisa ser **idêntico** ao aprovado, incluindo o idioma.
