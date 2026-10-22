CREATE TYPE "ProjectDocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR');
CREATE TYPE "ProjectMemoryKind" AS ENUM ('OBJECTIVE', 'CONSTRAINT', 'DECISION', 'FACT', 'DEFINITION', 'CONCLUSION', 'OTHER');
CREATE TYPE "ProjectMemorySource" AS ENUM ('USER', 'DOCUMENT', 'AI');

ALTER TABLE "Conversation" ADD COLUMN "projectId" TEXT;

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "instructions" TEXT,
  "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
  "documentsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectDocument" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "status" "ProjectDocumentStatus" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "contentText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectDocumentChunk" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL,
  "page" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectDocumentChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectMemory" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "kind" "ProjectMemoryKind" NOT NULL,
  "source" "ProjectMemorySource" NOT NULL,
  "sourceDocumentId" TEXT,
  "sourceConversationId" TEXT,
  "confidence" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Project_userId_name_key" ON "Project"("userId", "name");
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt" DESC);
CREATE UNIQUE INDEX "ProjectDocument_projectId_checksum_key" ON "ProjectDocument"("projectId", "checksum");
CREATE INDEX "ProjectDocument_projectId_status_updatedAt_idx" ON "ProjectDocument"("projectId", "status", "updatedAt" DESC);
CREATE UNIQUE INDEX "ProjectDocumentChunk_documentId_ordinal_key" ON "ProjectDocumentChunk"("documentId", "ordinal");
CREATE INDEX "ProjectDocumentChunk_documentId_idx" ON "ProjectDocumentChunk"("documentId");
CREATE INDEX "ProjectMemory_projectId_kind_updatedAt_idx" ON "ProjectMemory"("projectId", "kind", "updatedAt" DESC);
CREATE INDEX "ProjectMemory_sourceDocumentId_idx" ON "ProjectMemory"("sourceDocumentId");
CREATE INDEX "Conversation_projectId_updatedAt_idx" ON "Conversation"("projectId", "updatedAt" DESC);

ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDocumentChunk" ADD CONSTRAINT "ProjectDocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ProjectDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMemory" ADD CONSTRAINT "ProjectMemory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMemory" ADD CONSTRAINT "ProjectMemory_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "ProjectDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
