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
│   ├── core/inbox.ts          # Agrupa mensagens seguidas + fila por conversa
│   ├── domain/horarios.ts     # Regras puras de horário (períodos, dia, seleção)
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

O login dos usuários cadastrados é o **e-mail** (senhas com hash scrypt); crie-os em
**/admin/usuarios**. O `ADMIN_USER`/`ADMIN_PASSWORD` do ambiente continua valendo como
SUPER — é a chave reserva do operador, para ninguém ficar trancado fora do painel. Um
usuário do banco com o mesmo identificador tem prioridade sobre ela.

Se ainda assim ninguém conseguir entrar (senha perdida, usuário desativado), há a saída
pela linha de comando, apontando `DATABASE_URL` para o banco de produção:

```bash
npm run admin -- listar                          # quem existe e qual é o e-mail de login
npm run admin -- senha <e-mail> <senha-nova>     # redefine a senha
npm run admin -- criar <e-mail> <senha> [nome]   # cria um SUPER
npm run admin -- ativar <e-mail>                 # reativa um acesso desativado
```

Pelo painel dá para,
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

## Agrupamento de mensagens (uma resposta por vez)

O paciente costuma picotar o pedido ("teria que ser mais tarde" + "me manda outras
opções"). Cada mensagem chega num POST separado da Meta, então o agente espera
alguns segundos antes de responder e trata o conjunto como **um único turno** —
o campo *Espera antes de responder* no painel (`debounceSeconds`, padrão 8s).

Além de evitar a resposta dobrada, cada conversa roda **uma execução por vez**
(`src/core/inbox.ts`): sem isso duas mensagens simultâneas viravam duas execuções
paralelas, cada uma lendo e sobrescrevendo o mesmo histórico.

> Esse estado vive em memória, como o serviço roda hoje: **uma instância**
> (`min_machines_running = 1` no fly.toml; plano free do Render também).
> Ao escalar para várias instâncias, isto precisa migrar para um lock/fila
> compartilhados (Redis ou o próprio Postgres). Se o processo reiniciar dentro
> da janela de espera, o lote pendente se perde.

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
