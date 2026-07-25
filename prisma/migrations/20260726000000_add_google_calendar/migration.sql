-- AlterTable
ALTER TABLE "doctors" ADD COLUMN "googleCalendarId" TEXT;

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "googleEventId" TEXT;
