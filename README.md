# Agente de WhatsApp — Agendamento de Consultas (Multi-clínica)

Agente conversacional para agendamento automático de consultas via WhatsApp,
usando a **API Oficial do WhatsApp (Meta Cloud API)** e a **API da Anthropic (Claude)**
para conduzir a conversa de forma fluida.

> **Princípio central:** ser **multi-tenant / configurável**. A mesma base de código
> atende N clínicas. Cada cliente é um `Tenant`, com suas unidades, especialidades,
> médicos, convênios, horários, textos e regras — tudo por configuração, sem tocar no código.

---

## Stack

| Camada          | Escolha                          | Motivo |
|-----------------|----------------------------------|--------|
| Linguagem       | **Node.js + TypeScript**         | Máquina de estados tipada; ecossistema de webhooks maduro. |
| Banco           | **PostgreSQL** (via Docker no dev) | Mesmo banco em dev e produção (paridade). |
| ORM             | **Prisma**                       | Migrations versionadas + tipos gerados. |
| WhatsApp        | **Meta Cloud API** (oficial)     | Webhook + envio; roteamento por `phone_number_id`. |
| IA              | **Anthropic (Claude)**           | Entendimento de linguagem natural, extração e respostas fluidas. |

### Nota sobre o schema
Os campos de status são `String` (valores type-safe em [src/shared/enums.ts](src/shared/enums.ts))
e os campos "JSON" (`config`, `state`, `history`) são `String` serializado — mantém o
schema simples. Dá para migrar para `enum`/`jsonb` nativos do Postgres depois, se quiser.

---

## Estrutura de pastas

```
WhatsApp Agent/
├── prisma/
│   ├── schema.prisma          # Modelo de dados (multi-tenant, multi-unidade, convênios)
│   └── seed.ts                # CLI de seed (lê config/clinics/*.json)
├── config/clinics/
│   └── clinica-exemplo.json   # UM cliente: config (comportamento) + catalog (dados)
├── src/
│   ├── config/                # env validado + contratos (TenantConfig, ClinicFile)
│   ├── shared/                # enums, datetime, cpf, logger (pino)
│   ├── channels/whatsapp/     # webhook, assinatura, parse, envio
│   ├── ai/                    # Claude: anthropic, systemPrompt, tools
│   ├── core/engine.ts         # Motor de conversa (loop de tool use + memória)
│   ├── domain/scheduling.ts   # Regras de negócio (agendar, cancelar, remarcar)
│   ├── db/                    # Prisma, repositórios, seed reutilizável
│   └── server.ts              # Entrypoint (webhook HTTP)
├── scripts/chat.ts            # REPL de teste local (npm run chat)
├── test/                      # unit/ (sem banco) + integration/ (SQLite)
├── Dockerfile · docker-compose.yml · DEPLOY.md
├── vitest.config.ts · vitest.integration.config.ts
├── .env.example · package.json · tsconfig.json
```

## Rodando

```bash
npm install
cp .env.example .env          # preencha ANTHROPIC_API_KEY e os tokens do WhatsApp
docker compose up -d db       # sobe o PostgreSQL local
npx prisma migrate deploy     # aplica a migration (já versionada)
npm run seed                  # popula a clínica de exemplo (+ horários)
npm run chat                  # conversa com o agente no terminal (QA sem WhatsApp)
```

Servidor de webhook: `npm run dev`. Testes: `npm test` (unidade, sempre) e
`npm run test:integration` (requer um Postgres de teste em `TEST_DATABASE_URL`).
Deploy: [DEPLOY.md](DEPLOY.md) · Render blueprint em [render.yaml](render.yaml).

## Painel de administração

Com o servidor rodando (`npm run dev`), acesse **http://localhost:3000/admin**.

### Acessos (multi-clínica)
- **Administrador da plataforma (SUPER)** — vê e gerencia todas as clínicas e os usuários.
- **Usuário de clínica (CLINIC)** — enxerga **apenas a própria clínica**; campos técnicos
  (Phone Number ID, modelo de IA, nome do template) ficam ocultos.

Enquanto não existir nenhum usuário cadastrado, o login por `ADMIN_USER`/`ADMIN_PASSWORD`
funciona como SUPER. Crie o primeiro acesso em **/admin/usuarios** e, a partir daí, o login
passa a ser pelo banco (senhas com hash scrypt). Pelo painel dá para,
**sem editar arquivos**: criar/editar clínicas, ajustar textos, horário de
funcionamento, regras e modelo de IA, gerenciar unidades/especialidades/convênios/médicos,
gerar horários e ver os agendamentos. Os arquivos `config/clinics/*.json` seguem
válidos como **seed inicial / import** (`npm run seed`).

---

## Modelo de dados (resumo)

- **Tenant** → clínica (cliente da plataforma). Roteado pelo `whatsappPhoneNumberId`.
- **Unit** → unidade/filial. Uma clínica tem várias.
- **Specialty** → especialidade. Um **Doctor** pode ter **várias** (m-n) e atuar em **várias unidades** (m-n).
- **Insurer** (convênio) → **HealthPlan** (plano). Médicos aceitam planos (m-n).
- **Patient** + **PatientInsurance** (carteirinhas do paciente).
- **Slot** → janela de horário de um médico, numa unidade, para uma especialidade (`AVAILABLE/BOOKED/BLOCKED`).
- **Appointment** → agendamento; `healthPlanId` nulo = **particular**; `status` cobre cancelamento/remarcação.
- **Conversation** → memória do agente por telefone (estado da conversa).

---

## Como o multi-tenant funciona

1. Cada clínica é um `Tenant` com seu `whatsappPhoneNumberId`.
2. O webhook recebe a mensagem e a Meta informa qual número a recebeu
   (`metadata.phone_number_id`) → descobrimos **de qual clínica** é a conversa.
3. Comportamento e catálogo vêm de `config/clinics/<slug>.json`.

**Novo cliente = novo JSON + registro de tenant. Nenhuma linha de código muda.**

---

## Fases do desenvolvimento

- [x] **Fase 0 — Fundação:** estrutura + schema completo + config.
- [x] **Fase 1 — Canal WhatsApp:** webhook de verificação, recebimento (assinatura HMAC) e envio, com roteamento por tenant.
- [x] **Fase 2 — Motor + IA:** Claude conduz a conversa via *tool use*, com histórico persistido por telefone.
- [x] **Fase 3 — Domínio:** horários livres, agendar, cancelar e remarcar (com convênio/unidade) — expostos como ferramentas.
- [x] **Fase 4 — Operação:** seed real, logs estruturados (pino), testes (vitest), REPL de teste e deploy (Docker/Compose + [DEPLOY.md](DEPLOY.md)).
- [x] **Fase 5 — Painel:** login, CRUD de clínicas/catálogo, calendário, agendamento manual, FAQ, horários por médico.
- [x] **Fase 6 — Recursos de venda:** lembrete + confirmação (anti-falta, [WHATSAPP-TEMPLATES.md](WHATSAPP-TEMPLATES.md)),
      áudio transcrito (Groq), opções clicáveis no WhatsApp, transbordo humano e caixa de entrada.
