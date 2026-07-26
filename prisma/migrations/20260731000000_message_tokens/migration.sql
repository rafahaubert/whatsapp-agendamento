-- AlterTable: consumo de IA por mensagem (base de custo por clínica)
ALTER TABLE "messages" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "messages" ADD COLUMN "outputTokens" INTEGER;
