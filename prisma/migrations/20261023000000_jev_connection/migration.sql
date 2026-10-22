-- CreateEnum
CREATE TYPE "JevProtocol" AS ENUM ('HTTP', 'HTTPS');

-- CreateEnum
CREATE TYPE "ConnectionTarget" AS ENUM ('JEV', 'LLM', 'SEARCH');

-- CreateEnum
CREATE TYPE "ConnectionVerdict" AS ENUM ('OK', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "JevSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "host" TEXT NOT NULL DEFAULT '100.121.17.90',
    "port" INTEGER NOT NULL DEFAULT 8017,
    "protocol" "JevProtocol" NOT NULL DEFAULT 'HTTP',
    "apiKeyEnc" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "defaultThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "JevSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionTestRun" (
    "id" TEXT NOT NULL,
    "target" "ConnectionTarget" NOT NULL,
    "verdict" "ConnectionVerdict" NOT NULL,
    "latencyMs" INTEGER,
    "report" JSONB NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionTestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectionTestRun_target_createdAt_idx" ON "ConnectionTestRun"("target", "createdAt" DESC);

