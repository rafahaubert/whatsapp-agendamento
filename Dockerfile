# Imagem de produção do agente.
FROM node:22-slim

WORKDIR /app

# openssl é exigido pelo Prisma em runtime.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Aplica as migrations e sobe o servidor.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
