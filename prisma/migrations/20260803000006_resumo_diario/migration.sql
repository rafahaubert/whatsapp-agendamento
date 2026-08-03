-- Resumo diário para o responsável pela clínica.
--
-- Garante UM por dia: o job roda a cada 10 minutos e, sem esta marca, mandaria
-- um resumo a cada ciclo enquanto durasse a hora configurada.
ALTER TABLE "tenants" ADD COLUMN "lastDigestAt" TIMESTAMP(3);
