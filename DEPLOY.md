# Deploy

## 0. Custo e disponibilidade (leia antes de escolher o provedor)

### Por que o plano free "cai em modo silencioso"

O free do Render **hiberna após ~15 min sem tráfego** e leva ~50 s para acordar.
Não é uma queda visível: o serviço continua "verde" no dashboard, mas três coisas
param sem aviso —

1. **Webhooks perdidos.** A Meta espera poucos segundos por um `200` no
   `/webhook/whatsapp`. Durante os ~50 s de cold start ela recebe timeout,
   reenvia algumas vezes e, se o padrão persistir, **desativa o webhook do app**.
   O paciente manda mensagem e ninguém responde.
2. **Lembretes que nunca saem.** `enviarLembretes` / `renovarAgendas` /
   `enviarReativacoes` rodam em `setInterval` dentro do processo
   ([src/server.ts](src/server.ts)). Processo hibernado = nenhum ciclo roda.
3. **Lote de mensagens perdido.** O agrupamento de mensagens (`debounceSeconds`,
   padrão 8 s) vive **em memória**. Se a instância dorme ou reinicia dentro dessa
   janela, o lote pendente evapora.

Ou seja: para este app, o plano free não é "mais lento" — é **incorreto**. O
serviço precisa ficar **sempre no ar**.

### Quanto custa de verdade

> **O plano mais barato do Render não é US$ 25.** Os US$ 25/mês são o
> **workspace Pro**, que é opcional: o workspace **Hobby é gratuito** e já
> permite rodar instâncias pagas. A menor instância *always-on* é a
> **Starter, US$ 7/mês**. Você troca o tipo de instância no serviço, sem assinar
> o workspace Pro.

Comparação para este app (1 serviço web sempre no ar, Postgres gerenciado à
parte). Valores em real ao câmbio de ~R$ 5,10/US$:

| Opção | Instância | US$/mês | ~R$/mês | Observações |
|---|---|---:|---:|---|
| **Fly.io `gru` (recomendado)** | shared-cpu-1x, 512 MB | ~3,20 | **~R$ 16** | Região São Paulo, sempre no ar, `fly.toml` já pronto no repo |
| Fly.io `gru` enxuto | shared-cpu-1x, 256 MB | ~1,95 | ~R$ 10 | Apertado p/ Node + Prisma; só com `swap_size_mb` ligado |
| Render Starter | 512 MB | 7,00 | ~R$ 36 | Zero migração: é trocar o plano do serviço atual |
| VPS (Hetzner CX22) | 2 vCPU / 4 GB | ~4,80 | ~R$ 25 | Barato e folgado, mas servidor na Europa e **você administra** (Docker, TLS, updates) |
| Render free + ping externo | 512 MB | 0,00 | **R$ 0** | Ver abaixo — funciona, com ressalvas |
| ~~Render workspace Pro~~ | — | 25,00 | ~R$ 128 | **Não é necessário.** É o plano do workspace, não do servidor |

**Banco de dados: R$ 0.** Continue no **Neon** (free, já é o que o
[render.yaml](render.yaml) assume) ou no **Supabase São Paulo** (free). Não crie
Postgres no provedor de compute — é o item que mais encarece a conta.

### Recomendação

**Fly.io na região `gru` (São Paulo), 512 MB, sempre no ar: ~R$ 16/mês.**
É ~1/8 do que você temia, o servidor fica no Brasil (menos latência no webhook) e
o [fly.toml](fly.toml) deste repositório já está configurado exatamente assim
(`auto_stop_machines = "off"`, `min_machines_running = 1`). Vá para a
[seção 1c](#1c-deploy-no-flyio-são-paulo--recomendado). Fly cobra por segundo,
sem mensalidade fixa — mas conte com uma cobrança mínima na casa de US$ 5 em
meses de uso muito baixo.

Se preferir **não migrar nada**: no Render, abra o serviço → *Settings* →
*Instance Type* → **Starter (US$ 7)**. Resolve a hibernação hoje, sem tocar em
código, por ~R$ 36/mês.

### A opção R$ 0 (com ressalvas)

Dá para manter o free do Render acordado com um ping externo, porque a cota é de
**750 h/mês** e um mês tem no máximo 744 h — cabe um único serviço 24/7:

1. Crie um cron em [cron-job.org](https://cron-job.org) (grátis) chamando
   `GET https://SEU-APP.onrender.com/health` **a cada 10 minutos**.
2. Crie um segundo cron chamando
   `POST https://SEU-APP.onrender.com/jobs/run` com o header `x-jobs-token:
   $JOBS_TOKEN` **1x por hora** — assim os lembretes não dependem do
   `setInterval` do processo.

Ressalvas honestas: só funciona se este for o **único** serviço free do
workspace (senão as 750 h estouram e ele hiberna de novo no fim do mês); o free
tem CPU limitada, então a resposta é mais lenta; e todo deploy/reinício ainda
derruba os lotes em memória. Serve para validar com as primeiras clínicas — não
para uma operação que você cobra.

## 1. Banco de dados

O projeto já está em **PostgreSQL** e a migration inicial já está versionada em
`prisma/migrations/`. O deploy só precisa aplicá-la:

```bash
npx prisma migrate deploy
```

O `Dockerfile` já faz isso no start do container — em Render/Railway com Docker,
não há nada a fazer além de apontar `DATABASE_URL` para o Postgres do provedor.

## 1b. Deploy no Render

O repositório inclui [render.yaml](render.yaml) (Blueprint): no Render, **New →
Blueprint**, conecte o repositório e ele cria o **serviço web**. O Postgres é
**externo** (Neon) — o blueprint não cria banco. Depois, no dashboard, preencha os
segredos marcados como `sync: false` (`DATABASE_URL` do Neon,
`ANTHROPIC_API_KEY`, os `WHATSAPP_*`, `ADMIN_PASSWORD`). O `SESSION_SECRET` é gerado
automaticamente. HTTPS é automático.

> **Plano:** o `render.yaml` usa `plan: starter` (US$ 7/mês, ~R$ 36) porque o
> `free` hiberna e quebra o agente — ver [seção 0](#0-custo-e-disponibilidade-leia-antes-de-escolher-o-provedor).
> Isso **não** exige o workspace Pro de US$ 25: o workspace Hobby é grátis e já
> aceita instâncias pagas. Para voltar ao grátis (com as ressalvas da seção 0),
> troque para `plan: free`.

### Railway (alternativa)

New Project → **Deploy from GitHub** → adicione o plugin **PostgreSQL** → em
Variables, referencie `DATABASE_URL = ${{Postgres.DATABASE_URL}}` e defina as demais.
O Railway detecta o `Dockerfile` automaticamente.

## 1c. Deploy no Fly.io (São Paulo — recomendado)

O repositório inclui [fly.toml](fly.toml) (região `gru`, sempre no ar, ~R$ 16/mês).
Fluxo:

```bash
# 1. Instale o flyctl e faça login
fly auth login

# 2. Cria o app a partir do Dockerfile (não faz deploy ainda)
fly launch --no-deploy

# 3. Banco: use um Postgres gerenciado GRÁTIS (Neon ou Supabase São Paulo).
#    Copie a connection string DIRETA (porta 5432 — o pooler não roda migration):
fly secrets set DATABASE_URL="postgresql://...:5432/...?sslmode=require"
#    (Não use `fly postgres create`: vira mais uma máquina + volume na fatura.)

# 4. Segredos (não vão no fly.toml)
fly secrets set \
  ANTHROPIC_API_KEY=... \
  WHATSAPP_VERIFY_TOKEN=... \
  WHATSAPP_APP_SECRET=... \
  WHATSAPP_ACCESS_TOKEN=... \
  ADMIN_PASSWORD=uma-senha-forte \
  SESSION_SECRET=$(openssl rand -hex 32)

# 5. Deploy (builda o Dockerfile, roda migrate deploy no start)
fly deploy

# 6. Abre no navegador
fly open /admin
```

URL pública: `https://<app>.fly.dev`. Webhook da Meta:
`https://<app>.fly.dev/webhook/whatsapp`.

> **Banco (R$ 0):** mantenha o Postgres **fora** do Fly — **Neon** ou **Supabase
> (São Paulo)** no plano free dão conta do volume de uma clínica e não entram na
> fatura. Com qualquer um dos dois + Prisma, use a *Direct connection* (5432) no
> `DATABASE_URL`: a migration não roda pelo pooler de transações (6543).
> `fly postgres create` / `fly mpg` só valem quando o banco free ficar pequeno —
> cada um adiciona máquina + volume à conta.

> **Controle de gasto:** o Fly cobra por segundo de máquina ligada. Com uma
> `shared-cpu-1x` 512 MB em `gru` sempre no ar, o compute fica em ~US$ 3,20/mês e
> a banda de webhooks é desprezível (os primeiros GB saem de graça). Confira em
> `fly dashboard` → *Billing* e, se quiser trava, defina um limite de gasto na
> organização.

## 2. Variáveis de ambiente (produção)

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | String do PostgreSQL |
| `ANTHROPIC_API_KEY` | Chave da Anthropic |
| `WHATSAPP_VERIFY_TOKEN` | Token de verificação do webhook (você define na Meta) |
| `WHATSAPP_APP_SECRET` | Segredo do app (valida a assinatura do webhook) |
| `WHATSAPP_ACCESS_TOKEN` | Token de envio de mensagens |
| `WHATSAPP_API_VERSION` | Ex.: `v21.0` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Chave reserva do painel `/admin` (os demais acessos são criados em /admin/usuarios e entram pelo **e-mail**) |
| `SESSION_SECRET` | Segredo aleatório longo para assinar a sessão do painel |
| `NODE_ENV` | `production` (logs em JSON) |

> **Painel atrás de HTTPS:** em produção, sirva sob HTTPS e considere `cookie.secure`
> na sessão (com `app.set("trust proxy", 1)` se houver proxy). O `/admin` é para o
> operador da plataforma — proteja o acesso (rede interna/VPN se possível).

## 3. Subir

### Com Docker Compose (Postgres + app)

```bash
docker compose up --build
```

O container roda `prisma migrate deploy` no start e sobe o servidor.

### Manual

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

## 4. Popular clínicas

```bash
npm run seed
```

## 5. Webhook da Meta

O webhook **precisa ser HTTPS público**. Coloque o app atrás de um proxy/https
(Nginx, Caddy, Cloudflare, ou o TLS do provedor) e aponte a Meta para
`https://SEU_DOMINIO/webhook/whatsapp`.

## 6. Observações de escala

- **Logs**: em produção saem em JSON (pino) — plugue em Datadog/Loki/CloudWatch.
- **Token por clínica**: hoje o `WHATSAPP_ACCESS_TOKEN` é global. Para tokens
  distintos por clínica, guarde-os no `Tenant` (idealmente cifrados) e passe ao
  `sendWhatsAppText` — o ponto de extensão já existe em `src/channels/whatsapp/client.ts`.
- **Idempotência**: a Meta pode reenviar webhooks. Para evitar processar a mesma
  mensagem duas vezes, guarde os `messageId` já vistos (ex.: tabela ou cache).
- **Fila**: sob alto volume, troque o processamento inline por uma fila
  (BullMQ/SQS) após o ACK, para não segurar a resposta à Meta.
