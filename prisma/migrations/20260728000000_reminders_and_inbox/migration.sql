-- AlterTable: lembretes e confirmação de presença
ALTER TABLE "appointments" ADD COLUMN "reminderSentAt" TIMESTAMP(3);
ALTER TABLE "appointments" ADD COLUMN "confirmedAt" TIMESTAMP(3);

-- AlterTable: transbordo humano
ALTER TABLE "conversations" ADD COLUMN "humanHandoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversations" ADD COLUMN "handoffAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "conversations_tenantId_humanHandoff_idx" ON "conversations"("tenantId", "humanHandoff");

-- CreateTable: log de mensagens (caixa de entrada)
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "sentBy" TEXT NOT NULL DEFAULT 'BOT',
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_tenantId_phone_createdAt_idx" ON "messages"("tenantId", "phone", "createdAt");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
