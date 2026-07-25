import { PrismaClient } from "@prisma/client";

/**
 * Instância única do Prisma compartilhada pela aplicação.
 * (Rode `npm run prisma:generate` / `prisma migrate dev` antes do primeiro uso.)
 */
export const prisma = new PrismaClient();
