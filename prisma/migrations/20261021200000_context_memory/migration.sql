-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('PREFERENCE', 'FACT', 'PROJECT');

-- CreateEnum
CREATE TYPE "MemorySource" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "SummaryStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'STALE');

-- CreateEnum
CREATE TYPE "CompactionStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "memoryAutoSave" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "memoryEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "contextAutoCompactPct" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "contextDefaultWindow" INTEGER NOT NULL DEFAULT 8192,
ADD COLUMN     "contextHighPct" INTEGER NOT NULL DEFAULT 85,
ADD COLUMN     "contextResponseReserve" INTEGER NOT NULL DEFAULT 1024,
ADD COLUMN     "contextWarnPct" INTEGER NOT NULL DEFAULT 70,
ADD COLUMN     "memoryFeatureEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "compactedAt" TIMESTAMP(3),
ADD COLUMN     "compactionError" TEXT,
ADD COLUMN     "compactionStartedAt" TIMESTAMP(3),
ADD COLUMN     "compactionStatus" "CompactionStatus";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "contextUsage" JSONB,
ADD COLUMN     "promptTokens" INTEGER;

-- CreateTable
CREATE TABLE "ModelContextConfig" (
    "model" TEXT NOT NULL,
    "contextWindow" INTEGER NOT NULL,
    "responseReserve" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ModelContextConfig_pkey" PRIMARY KEY ("model")
);

-- CreateTable
CREATE TABLE "ContextSummary" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SummaryStatus" NOT NULL DEFAULT 'ACTIVE',
    "content" JSONB NOT NULL,
    "text" TEXT NOT NULL,
    "coveredMessageId" TEXT NOT NULL,
    "coveredUntil" TIMESTAMP(3) NOT NULL,
    "coveredCount" INTEGER NOT NULL,
    "tokensBefore" INTEGER,
    "tokensAfter" INTEGER,
    "summaryTokens" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "project" TEXT,
    "content" TEXT NOT NULL,
    "source" "MemorySource" NOT NULL DEFAULT 'MANUAL',
    "sourceConversationId" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContextSummary_conversationId_status_idx" ON "ContextSummary"("conversationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContextSummary_conversationId_version_key" ON "ContextSummary"("conversationId", "version");

-- CreateIndex
CREATE INDEX "Memory_userId_kind_idx" ON "Memory"("userId", "kind");

-- AddForeignKey
ALTER TABLE "ContextSummary" ADD CONSTRAINT "ContextSummary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

