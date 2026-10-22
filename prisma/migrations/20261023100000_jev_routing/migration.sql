-- CreateEnum
CREATE TYPE "RoutingAuthMode" AS ENUM ('AUTO', 'MANUAL', 'HYBRID', 'OFF');

-- CreateEnum
CREATE TYPE "RoutingDecisionStatus" AS ENUM ('PENDING', 'APPLIED', 'DISCARDED');

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "routingAuthMode" "RoutingAuthMode";

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "routingAutoAccept" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "routing" JSONB;

-- CreateTable
CREATE TABLE "RoutingSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "modes" JSONB NOT NULL,
    "defaultAuthMode" "RoutingAuthMode" NOT NULL DEFAULT 'HYBRID',
    "highThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "fallbackModes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includeContext" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "RoutingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "excerpt" TEXT NOT NULL,
    "authMode" "RoutingAuthMode" NOT NULL,
    "probabilities" JSONB,
    "config" JSONB NOT NULL,
    "outcomes" JSONB NOT NULL,
    "finalModes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userChoice" TEXT,
    "status" "RoutingDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "jevModel" TEXT,
    "jevLatencyMs" INTEGER,
    "jevError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "RoutingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoutingDecision_messageId_key" ON "RoutingDecision"("messageId");

-- CreateIndex
CREATE INDEX "RoutingDecision_createdAt_idx" ON "RoutingDecision"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "RoutingDecision_userId_createdAt_idx" ON "RoutingDecision"("userId", "createdAt" DESC);

