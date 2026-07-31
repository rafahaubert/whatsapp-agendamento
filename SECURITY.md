# Segurança

Notas sobre as defesas do sistema e o estado das dependências. Serve para quem
for auditar não repetir trabalho e para não confundir "número no `npm audit`" com
"risco real".

## Defesas em vigor

| Superfície | Proteção |
|---|---|
| `POST /webhook/whatsapp` | HMAC `X-Hub-Signature-256` com `WHATSAPP_APP_SECRET`, comparação em tempo constante, corpo cru preservado, limite de 100kb. **Fail-closed**: sem header, sem corpo ou assinatura errada → 401. A variável é obrigatória no boot, então não existe caminho em que a validação seja desligada. Rate limit aplicado *depois* da assinatura |
| `GET /webhook/whatsapp` | `hub.verify_token` comparado em tempo constante |
| `POST /jobs/run`, `/jobs/reminders` | `JOBS_TOKEN` via header `x-jobs-token`, comparação em tempo constante, rate limit. Sem a variável configurada → 401 em tudo. **Não** aceita o token por query string (vazaria em access log e Referer) |
| Login do painel | scrypt com salt por usuário (`salt:hash`); a credencial reserva do ambiente é comparada em tempo constante. Dois limitadores: por `usuário\|IP` (8/15min) e por IP (30/15min, cobre enumeração de usuários) |
| Sessão do painel | Cookie `httpOnly`, `sameSite=lax`, `secure` em produção, nome próprio, 8h. Store em Postgres. ID regenerado no login (session fixation) e destruído no logout |
| Formulários do painel | Token de CSRF por sessão em todos os ~39 POSTs, aceito no campo `_csrf` ou no header `x-csrf-token`, validado em tempo constante |
| Isolamento entre clínicas | `requireTenant` em todas as rotas `/clinicas/:id/*` |
| Views | Dados de paciente e de clínica sempre com `<%= %>` (escapado). Nenhum `<%- %>` recebe dado de usuário |
| Logs | `redact` do pino em segredos (sempre) e dados pessoais (em produção); telefone e identificador de login mascarados na origem (`src/shared/pii.ts`) |
| Integridade do agendamento | Transações em `SERIALIZABLE` com retry, mais lock otimista na reserva do slot (`updateMany` condicional). Ver `src/domain/transacao.ts`. Antes de confirmar, consulta a disponibilidade no Google Calendar do dentista |
| `/health` | Consulta o banco de verdade; responde 503 se ele estiver inacessível |
| Encerramento | SIGTERM/SIGINT param de aceitar conexões, processam os lotes de mensagens pendentes e só então saem |
| Imagem de produção | Multi-stage, sem devDependencies, rodando como usuário sem privilégios |

## Estado do `npm audit`

O `npm audit` reporta advisories **transitivos**, e conta uma vez por pacote da
cadeia — o que infla o número. Nenhum dos que restam é alcançável em produção
neste sistema. Reavaliar a cada bump de dependência.

### Resolvidos

| Advisory | Como |
|---|---|
| `uuid <11.1.1` (moderate) — bounds check em v3/v5/v6 | `@googleapis/calendar` 9 → 15. O `uuid` **nunca foi dependência direta** nem é importado pelo código: entrava via `gaxios`/`googleapis-common`. O projeto usa `crypto.randomUUID()` |
| `ejs` via `jake → filelist → minimatch → brace-expansion` (high) | `ejs` 3 → 6. As 26 views compilam e renderizam sem alteração |

### Aceitos, com justificativa

**`brace-expansion` DoS (GHSA-mh99-v99m-4gvg)** — aparece como 7 entradas
(`brace-expansion`, `minimatch`, `glob`, `rimraf`, `gaxios`, `gcp-metadata`,
`googleapis-common`), mas é **um** advisory: cada pacote da cadeia é contado
porque depende do anterior.

Cadeia: `@googleapis/calendar → googleapis-common → gaxios → rimraf → glob →
minimatch → brace-expansion@2.1.3`.

Não é alcançável: o ataque exige que o agressor controle o **padrão de glob**, e
aqui os padrões vêm do código interno do `gaxios` (limpeza de arquivos
temporários). O projeto não usa `glob`, `minimatch` nem `rimraf` diretamente, e
nenhuma entrada de paciente ou do painel chega a eles.

Não corrigido de propósito: o patch é `brace-expansion@5.0.8`, mas o
`minimatch@9` da cadeia declara `^2.0.1`. Forçar por `overrides` seria um salto
de major numa primitiva de casamento de padrões, e **nenhum teste deste
repositório exercita esse caminho** — a quebra apareceria só em produção, dentro
da sincronização com o Google Calendar. Trocar um risco inalcançável por um
risco real de quebra não se paga. Sai sozinho quando o `gaxios` atualizar o
`rimraf`.

**`vitest` (critical), `vite`, `esbuild`, `@vitest/mocker`, `vite-node`** — todos
`devDependencies`. O critical exige o **servidor de UI do Vitest** no ar
(`vitest --ui`), que este projeto nunca roda: os scripts usam `vitest run`. Os de
`vite`/`esbuild` afetam o **dev server**, que também não é usado (o build é
`tsc`). Corrigir exige `vitest` 2 → 4, breaking nos 24 arquivos de teste.

Ressalva operacional: o `Dockerfile` é single-stage e faz `npm ci` sem prune,
então essas devDependencies **vão para a imagem de produção**. Elas não são
executadas, mas removê-las reduziria a superfície. Não é trivial: o `CMD` depende
do CLI `prisma`, que é devDependency — mover para `dependencies` antes.

## Limitações conhecidas

- **Instância única.** Agrupamento de mensagens, lock por conversa, contador de
  força bruta e rate limits vivem na memória do processo. Com 2+ instâncias os
  tetos multiplicam e o lock por conversa deixa de valer. `fly.toml` fixa
  `min_machines_running = 1`; ao escalar, migrar esse estado para o banco antes.
- **Recuperação de queda abrupta.** O encerramento por SIGTERM processa os lotes
  pendentes antes de sair (é o caso do deploy). Uma morte sem SIGTERM — OOM,
  SIGKILL, queda de máquina — ainda perde o lote que estava na janela de
  agrupamento: a marca de idempotência é liberada só pelo caminho de erro, que
  não roda quando o processo morre de uma vez. Fechar isso exigiria persistir a
  mensagem e retomá-la no boot.
- **Plano free do Render hiberna**, o que faz a Meta receber timeout no webhook.
  Ver o comentário no `render.yaml`. É decisão de custo, não de código.
- **Checagem do Google acontece na confirmação, não na listagem.** O paciente
  pode ver um horário que o dentista bloqueou no Google e só receber a recusa ao
  confirmar. Detalhes em `GOOGLE.md`.
- **Sem `packageManager` fixado.** `engines` declara Node >= 20; o gerenciador
  de pacotes não está travado.

## Itens já resolvidos

Ficam registrados porque apareceram em auditorias anteriores e a documentação
antiga ainda pode circular:

- ~~Webhook at-most-once perdia mensagem no deploy~~ → SIGTERM/SIGINT drenam a
  caixa de entrada (`drenarCaixaDeEntrada`), o `CMD` do Dockerfile usa `exec`
  para o Node receber o sinal, e `kill_timeout` de 30s no `fly.toml`.
- ~~Marca de idempotência ficava presa após falha~~ → liberada quando o
  processamento falha ou quando nada chega ao paciente.
- ~~`processed_messages` crescia sem limite~~ → poda diária, retenção de 30 dias.
- ~~`ADMIN_PASSWORD` só em texto plano~~ → `ADMIN_PASSWORD_HASH` (scrypt) com
  precedência; o texto plano segue aceito para não quebrar deploy existente, com
  aviso no startup. Gere com `npm run admin -- hash <senha>`.
- ~~Google Calendar era só escrita~~ → consulta `freebusy` antes de confirmar
  agendamento e remarcação.
- ~~Ordem dos botões de template era suposição implícita~~ → declarada em
  `reminders.botoes` e validada (`ordemDosBotoes`).
- ~~Sem CI~~ → workflow rodando build, lint, testes de unidade e de integração
  contra Postgres, mais o build da imagem Docker.
- ~~devDependencies iam para a imagem de produção~~ → Dockerfile multi-stage com
  prune, rodando como usuário `node`.
