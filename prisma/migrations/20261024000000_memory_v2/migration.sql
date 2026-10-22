-- Mémoire persistante v2 (1/2) : portée projet, certitude, historique, renforcement, file d'analyse et oublis.
-- Les nouvelles valeurs d'enum ne sont utilisables qu'après validation : la copie des données est dans la migration suivante.

-- CreateEnum
CREATE TYPE "MemoryCertainty" AS ENUM ('CONFIRMED', 'STATED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "MemoryJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'SKIPPED', 'FAILED');

-- AlterEnum

ALTER TYPE "MemoryKind" ADD VALUE 'DECISION';
ALTER TYPE "MemoryKind" ADD VALUE 'CONSTRAINT';
ALTER TYPE "MemoryKind" ADD VALUE 'OBJECTIVE';

-- AlterEnum
ALTER TYPE "MemorySource" ADD VALUE 'DOCUMENT';

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "memoryModel" TEXT;

-- AlterTable
ALTER TABLE "Memory" ADD COLUMN     "certainty" "MemoryCertainty" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "importance" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "mentionCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "sourceDocumentId" TEXT,
ADD COLUMN     "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "supersededById" TEXT,
ADD COLUMN     "topic" TEXT;

-- CreateTable
CREATE TABLE "MemoryJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "projectId" TEXT,
    "model" TEXT NOT NULL,
    "status" "MemoryJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "error" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryTombstone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "fingerprint" TEXT[],
    "topicHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryJob_status_nextAttemptAt_idx" ON "MemoryJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "MemoryJob_userId_status_idx" ON "MemoryJob"("userId", "status");

-- CreateIndex
CREATE INDEX "MemoryJob_messageId_idx" ON "MemoryJob"("messageId");

-- CreateIndex
CREATE INDEX "MemoryTombstone_userId_createdAt_idx" ON "MemoryTombstone"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Memory_userId_status_projectId_idx" ON "Memory"("userId", "status", "projectId");

-- CreateIndex
CREATE INDEX "Memory_userId_topic_idx" ON "Memory"("userId", "topic");

-- CreateIndex
CREATE INDEX "Memory_projectId_status_idx" ON "Memory"("projectId", "status");

-- CreateIndex
CREATE INDEX "Memory_sourceDocumentId_idx" ON "Memory"("sourceDocumentId");

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "ProjectDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryTombstone" ADD CONSTRAINT "MemoryTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Souvenirs enregistrés automatiquement avant cette version : exprimés par l'utilisateur, non confirmés explicitement.
UPDATE "Memory" SET "certainty" = 'STATED' WHERE "source" = 'AUTO';
