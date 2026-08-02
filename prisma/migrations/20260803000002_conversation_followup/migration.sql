-- AlterTable: follow-up de conversa abandonada.
-- Marca a cutucada já enviada — é o que garante uma só por conversa.
ALTER TABLE "conversations" ADD COLUMN "followUpSentAt" TIMESTAMP(3);
