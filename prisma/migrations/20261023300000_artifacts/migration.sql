-- CreateEnum
CREATE TYPE "ArtifactOrigin" AS ENUM ('GENERATED', 'EDITED', 'REPAIRED');

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "origin" "ArtifactOrigin" NOT NULL DEFAULT 'GENERATED',
    "issues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "runtimeError" TEXT,
    "autoRepairUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Artifact_messageId_idx" ON "Artifact"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_conversationId_key_version_key" ON "Artifact"("conversationId", "key", "version");

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

