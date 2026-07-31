# Deploy

## 1. Banco de dados

O projeto já está em **PostgreSQL** e a migration inicial já está versionada em
`prisma/migrations/`. O deploy só precisa aplicá-la:

```bash
npx prisma migrate deploy
```

O `Dockerfile` já faz isso no start do container — em Render/Railway com Docker,
não há nada a fazer além de apontar `DATABASE_URL` para o Postgres do provedor.

## 1b. Deploy no Render (recomendado para começar)

O repositório inclui [render.yaml](render.yaml) (Blueprint): no Render, **New →
Blueprint**, conecte o repositório e ele cria o **Postgres + o serviço web** juntos.
Depois, no dashboard, preencha os segredos marcados como `sync: false`
(`ANTHROPIC_API_KEY`, os `WHATSAPP_*`, `ADMIN_PASSWORD`). O `SESSION_SECRET` é gerado
automaticamente e o `DATABASE_URL` é injetado do banco. HTTPS é automático.

> O plano **free** do Postgres do Render expira em 90 dias — para uso real, troque
> `plan: free` por `basic` no `render.yaml`.

### Railway (alternativa)

New Project → **Deploy from GitHub** → adicione o plugin **PostgreSQL** → em
Variables, referencie `DATABASE_URL = ${{Postgres.DATABASE_URL}}` e defina as demais.
O Railway detecta o `Dockerfile` automaticamente.

## 1c. Deploy no Fly.io (região São Paulo — recomendado p/ Brasil)

O repositório inclui [fly.toml](fly.toml) (região `gru`, sempre no ar). Fluxo:

```bash
# 1. Instale o flyctl e faça login
fly auth login

# 2. Cria o app a partir do Dockerfile (não faz deploy ainda)
fly launch --no-deploy

# 3. Banco: crie um Postgres na região gru e "anexe" (isso já define DATABASE_URL)
fly postgres create --region gru
fly postgres attach <nome-do-db-app>
#    Alternativa gerenciada: Supabase (São Paulo) → copie a "Direct connection"
#    (porta 5432, necessária p/ as migrations do Prisma) e rode:
#    fly secrets set DATABASE_URL="postgresql://...:5432/postgres"

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

> **Banco:** o `fly postgres create` é a opção "faça você mesmo" (com snapshots
> diários). Para algo mais gerenciado, use **Fly Managed Postgres** (`fly mpg`) ou
> **Supabase (São Paulo)**. Com Supabase + Prisma, use a *Direct connection* (5432)
> no `DATABASE_URL` — a migration não roda pelo pooler de transações (6543).

## 2. Variáveis de ambiente (produção)

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | String do PostgreSQL |
| `ANTHROPIC_API_KEY` | Chave da Anthropic |
| `WHATSAPP_VERIFY_TOKEN` | Token de verificação do webhook (você define na Meta) |
| `WHATSAPP_APP_SECRET` | Segredo do app (valida a assinatura do webhook) |
| `WHATSAPP_ACCESS_TOKEN` | Token de envio de mensagens |
| `WHATSAPP_API_VERSION` | Ex.: `v21.0` |
| `ADMIN_USER` + `ADMIN_PASSWORD_HASH` | Chave reserva do painel `/admin` (os demais acessos são criados em /admin/usuarios e entram pelo **e-mail**). Gere o hash com `npm run admin -- hash <senha>` |
| `ADMIN_PASSWORD` | Alternativa à anterior, com a senha em texto plano. Continua funcionando, mas prefira o hash — ver o aviso abaixo |
| `SESSION_SECRET` | **Obrigatório em produção.** Segredo aleatório longo para assinar a sessão do painel |
| `JOBS_TOKEN` | Protege `POST /jobs/run` e `/jobs/reminders`. **Sem ele os jobs respondem 401 a tudo** — necessário para o cron externo (ver [WHATSAPP-TEMPLATES.md](WHATSAPP-TEMPLATES.md)) |
| `NODE_ENV` | `production` (logs em JSON) |

> ⚠️ **`SESSION_SECRET` agora é obrigatório em produção: sem ele o processo NÃO
> sobe.** Antes existia um valor padrão, e como ele está publicado neste
> repositório qualquer pessoa conseguiria forjar um cookie de sessão e entrar no
> painel como administrador. Havia um aviso de startup para esse caso, mas ele
> comparava com uma string diferente do padrão real e nunca disparava — então o
> deploy subia inseguro em silêncio. Agora a validação de ambiente barra o boot,
> como já fazia com `DATABASE_URL`.
>
> No Render o `render.yaml` já gera o valor (`generateValue: true`). **No Fly.io é
> preciso definir manualmente** — está no `fly secrets set` do passo 4 acima:
> `SESSION_SECRET=$(openssl rand -hex 32)`.

> **Senha da chave reserva: prefira o hash.** `ADMIN_PASSWORD` guarda a senha em
> texto plano, e ela fica legível no dashboard do provedor, em `fly secrets list`
> e em qualquer dump de ambiente. Gere o hash (scrypt, o mesmo dos usuários do
> banco) e troque a variável:
>
> ```bash
> npm run admin -- hash 'uma-senha-forte'
> # → ADMIN_PASSWORD_HASH=<salt>:<hash>
>
> fly secrets set 'ADMIN_PASSWORD_HASH=<salt>:<hash>'
> fly secrets unset ADMIN_PASSWORD
> ```
>
> As duas formas seguem aceitas (defina ao menos uma, senão o boot falha); quando
> as duas existem, o hash vence. Rodar em produção só com `ADMIN_PASSWORD` gera
> um aviso no startup.

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
- **Idempotência**: já implementada. A Meta reenvia webhooks, e a tabela
  `processed_messages` guarda os `messageId` (wamid) usando a chave primária como
  trava atômica — ver `src/db/idempotency.ts`. Duas ressalvas conhecidas: o wamid
  é marcado *antes* do processamento (então uma mensagem em voo se perde se o
  processo morrer no meio, sem reentrega), e a tabela ainda **não tem rotina de
  poda** — cresce indefinidamente.
- **Sessão do painel**: fica no Postgres (tabela `sessions`, ver
  `src/admin/sessionStore.ts`), não em memória — os operadores continuam logados
  depois de um deploy. A poda dos registros expirados roda de hora em hora.
- **Instância única**: o serviço é desenhado para UMA instância. O agrupamento de
  mensagens (`src/core/inbox.ts`), o contador de força bruta do login e os rate
  limits vivem em memória do processo. Com 2+ instâncias cada uma contaria em
  separado e o lock por conversa deixaria de valer. `fly.toml` fixa
  `min_machines_running = 1`; ao escalar, migrar esse estado para o banco antes.
- **Fila**: sob alto volume, troque o processamento inline por uma fila
  (BullMQ/SQS) após o ACK, para não segurar a resposta à Meta.
