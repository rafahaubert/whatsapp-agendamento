-- CreateTable: fila de espera
CREATE TABLE "waitlist" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "periodo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_tenantId_specialtyId_status_idx" ON "waitlist"("tenantId", "specialtyId", "status");

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: controle de reativação (evita contato repetido)
ALTER TABLE "patients" ADD COLUMN "lastRecallAt" TIMESTAMP(3);
