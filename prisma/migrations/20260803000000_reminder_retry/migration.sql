-- AlterTable: corta o reenvio infinito de lembrete.
-- Falha no envio não gravava `reminderSentAt`, então o mesmo agendamento voltava
-- a cada ciclo do cron (10 min) para sempre. Com o contador, sai da fila após 3.
ALTER TABLE "appointments" ADD COLUMN "reminderRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "appointments" ADD COLUMN "reminderLastError" TEXT;
