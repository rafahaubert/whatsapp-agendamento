-- Fila de espera: reserva temporária do horário e reoferta ao próximo.
--
-- Antes, avisar o primeiro da fila não segurava o horário para ele: qualquer
-- outro paciente podia levá-lo antes de a mensagem ser lida. E quem não
-- respondia virava NOTIFIED para sempre — ninguém mais era avisado e o
-- candidato sumia da fila em silêncio.

-- Reserva temporária do horário para quem foi avisado.
ALTER TABLE "slots" ADD COLUMN "reservedUntil" TIMESTAMP(3);
ALTER TABLE "slots" ADD COLUMN "reservedForPatientId" TEXT;

-- Consulta do job de expiração: reservas vencidas.
CREATE INDEX "slots_reservedUntil_idx" ON "slots"("reservedUntil");

-- Qual horário foi oferecido nesta notificação.
ALTER TABLE "waitlist" ADD COLUMN "slotId" TEXT;

-- Ofertas ignoradas: ordena a fila e encerra quem não responde.
ALTER TABLE "waitlist" ADD COLUMN "ofertasPerdidas" INTEGER NOT NULL DEFAULT 0;

-- Consulta do job de expiração: quem está com oferta pendente.
CREATE INDEX "waitlist_status_notifiedAt_idx" ON "waitlist"("status", "notifiedAt");
