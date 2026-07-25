-- CreateTable
CREATE TABLE "processed_messages" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processed_messages_createdAt_idx" ON "processed_messages"("createdAt");
