-- CreateEnum
CREATE TYPE "SearchProviderType" AS ENUM ('SEARXNG', 'BRAVE');

-- CreateEnum
CREATE TYPE "WebSearchStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "braveApiKey" TEXT,
ADD COLUMN     "searchCacheTtlSec" INTEGER NOT NULL DEFAULT 900,
ADD COLUMN     "searchMaxPages" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "searchMaxResults" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "searchProvider" "SearchProviderType" NOT NULL DEFAULT 'SEARXNG',
ADD COLUMN     "searchTimeoutMs" INTEGER NOT NULL DEFAULT 20000,
ADD COLUMN     "searxngUrl" TEXT,
ADD COLUMN     "webSearchAutoDefault" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "webSearchEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "webSearch" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "webSearchDefault" BOOLEAN;

-- CreateTable
CREATE TABLE "WebSearch" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT,
    "provider" "SearchProviderType" NOT NULL,
    "model" TEXT,
    "status" "WebSearchStatus" NOT NULL DEFAULT 'RUNNING',
    "queries" TEXT[],
    "steps" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "cited" INTEGER[],
    "limitations" TEXT[],
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebSearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebSearch_messageId_key" ON "WebSearch"("messageId");

-- AddForeignKey
ALTER TABLE "WebSearch" ADD CONSTRAINT "WebSearch_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
