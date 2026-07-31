# Imagem de produção do agente.
#
# Multi-stage: o primeiro estágio compila (precisa de typescript e afins); o
# segundo leva só o que roda. Antes era um estágio só, sem prune, então as
# devDependencies iam para produção — inclusive o vitest, que tem CVE crítico e
# nunca é executado lá. Não eram exploráveis (nada as chama), mas não têm por
# que estar na imagem.

# ---------- Estágio 1: build ----------
FROM node:22-slim AS build

WORKDIR /app

# openssl é exigido pelo Prisma para gerar e rodar o client.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# Descarta as devDependencies do node_modules que vai para a imagem final.
# `prisma` (CLI) e `tsx` estão em dependencies de propósito: o CMD roda
# `prisma migrate deploy`, e os scripts de operação (seed, admin) usam tsx.
# O generate roda de novo porque o prune apaga o client já gerado.
RUN npm prune --omit=dev && npx prisma generate

# ---------- Estágio 2: runtime ----------
FROM node:22-slim AS runtime

WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# `node` é um usuário sem privilégios que já vem na imagem oficial. Rodar como
# root dava ao processo mais poder do que ele precisa.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/package*.json ./
# Views e estáticos ficam FORA de dist: src/server.ts os resolve a partir do cwd.
COPY --chown=node:node --from=build /app/views ./views
COPY --chown=node:node --from=build /app/public ./public
# Usados pelo seed e pela página /proposta.
COPY --chown=node:node --from=build /app/config ./config
COPY --chown=node:node --from=build /app/marketing ./marketing

USER node

EXPOSE 3000

# Aplica as migrations e sobe o servidor.
#
# `exec` é essencial: sem ele o `sh` continua sendo o PID 1 e fica com o SIGTERM
# do provedor, então o encerramento gracioso do servidor (que processa os lotes
# de mensagens ainda na janela de agrupamento) nunca rodaria — e o container
# levaria SIGKILL com mensagens de paciente pendentes.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]
