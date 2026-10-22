-- Bibliothèque documentaire v2 : ingestion progressive, index hybride (BM25 + embeddings), synthèses et méthodes.
-- Voir src/lib/documents. Les documents importés avant cette migration restent consultables (contentText, segments).

-- Recherche plein texte insensible aux accents. unaccent() n'est pas IMMUTABLE : enveloppe dédiée,
-- utilisée pour construire tsv à l'écriture et pour les requêtes.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION iatrano_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('PDF', 'DOCX', 'PPTX', 'XLSX', 'CSV', 'TEXT', 'MARKDOWN', 'JSON', 'HTML', 'IMAGE', 'VIDEO', 'AUDIO');

-- CreateEnum
CREATE TYPE "DocumentStage" AS ENUM ('QUEUED', 'EXTRACT', 'OCR', 'SEGMENT', 'INDEX', 'EMBED', 'ANALYZE', 'SYNTHESIZE', 'DONE');

-- CreateEnum
CREATE TYPE "DocumentUnitMethod" AS ENUM ('TEXT', 'OCR', 'TRANSCRIPT', 'KEYFRAME', 'NONE');

-- CreateEnum
CREATE TYPE "DocumentUnitStatus" AS ENUM ('OK', 'EMPTY', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SegmentType" AS ENUM ('TEXT', 'TABLE', 'CAPTION', 'OCR', 'TRANSCRIPT', 'VISUAL', 'NOTE');

-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('SUMMARY', 'CONCEPT', 'DEFINITION', 'METHOD', 'RULE', 'CONTRADICTION', 'RELATION', 'TIMELINE');

-- CreateEnum
CREATE TYPE "InsightOrigin" AS ENUM ('EXPLICIT', 'INFERRED');

-- CreateEnum
CREATE TYPE "DocumentJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ProjectDocument" ADD COLUMN     "analyzedAt" TIMESTAMP(3),
ADD COLUMN     "indexedAt" TIMESTAMP(3),
ADD COLUMN     "kind" "DocumentKind" NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "language" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "progress" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "stage" "DocumentStage" NOT NULL DEFAULT 'QUEUED',
ADD COLUMN     "storagePath" TEXT,
ADD COLUMN     "unitCount" INTEGER,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ProjectDocumentChunk" ADD COLUMN     "contentHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "embedding" BYTEA,
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "endMs" INTEGER,
ADD COLUMN     "lexCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pageEnd" INTEGER,
ADD COLUMN     "sectionId" TEXT,
ADD COLUMN     "sectionPath" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "startMs" INTEGER,
ADD COLUMN     "tsv" tsvector,
ADD COLUMN     "type" "SegmentType" NOT NULL DEFAULT 'TEXT';

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT,
    "method" "DocumentUnitMethod" NOT NULL,
    "status" "DocumentUnitStatus" NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "error" TEXT,
    "text" TEXT NOT NULL,
    "imagePath" TEXT,
    "visual" JSONB,
    "startMs" INTEGER,
    "endMs" INTEGER,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSection" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "path" TEXT[],
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "startMs" INTEGER,
    "endMs" INTEGER,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "analysis" JSONB,
    "analysisStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "analysisModel" TEXT,
    "analyzedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentInsight" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "InsightKind" NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "text" TEXT NOT NULL,
    "origin" "InsightOrigin" NOT NULL DEFAULT 'EXPLICIT',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "sectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "DocumentJobStatus" NOT NULL DEFAULT 'PENDING',
    "stage" "DocumentStage" NOT NULL DEFAULT 'QUEUED',
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "stages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCache" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" BYTEA,
    "json" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DocumentSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "embeddingModel" TEXT,
    "embeddingBaseUrl" TEXT,
    "ocrEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ocrLanguages" TEXT NOT NULL DEFAULT 'fra+eng',
    "visionModel" TEXT,
    "transcriptionUrl" TEXT,
    "transcriptionModel" TEXT,
    "analysisEnabled" BOOLEAN NOT NULL DEFAULT true,
    "analysisModel" TEXT,
    "chunkTargetTokens" INTEGER NOT NULL DEFAULT 450,
    "chunkOverlapTokens" INTEGER NOT NULL DEFAULT 60,
    "maxFileMb" INTEGER NOT NULL DEFAULT 300,
    "maxUnits" INTEGER NOT NULL DEFAULT 3000,
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "retrievalMaxPassages" INTEGER NOT NULL DEFAULT 10,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "DocumentSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRetrieval" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "queries" TEXT[],
    "sources" JSONB NOT NULL DEFAULT '[]',
    "cited" INTEGER[],
    "checks" JSONB NOT NULL DEFAULT '[]',
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentRetrieval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPage_documentId_number_key" ON "DocumentPage"("documentId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSection_documentId_ordinal_key" ON "DocumentSection"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "DocumentInsight_documentId_kind_status_idx" ON "DocumentInsight"("documentId", "kind", "status");

-- CreateIndex
CREATE INDEX "DocumentInsight_projectId_kind_status_idx" ON "DocumentInsight"("projectId", "kind", "status");

-- CreateIndex
CREATE INDEX "DocumentJob_status_nextAttemptAt_idx" ON "DocumentJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DocumentJob_documentId_createdAt_idx" ON "DocumentJob"("documentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DocumentCache_kind_createdAt_idx" ON "DocumentCache"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRetrieval_messageId_key" ON "DocumentRetrieval"("messageId");

-- CreateIndex
CREATE INDEX "ProjectDocumentChunk_documentId_page_idx" ON "ProjectDocumentChunk"("documentId", "page");

-- CreateIndex
CREATE INDEX "ProjectDocumentChunk_tsv_idx" ON "ProjectDocumentChunk" USING GIN ("tsv");

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ProjectDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ProjectDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSection" ADD CONSTRAINT "DocumentSection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ProjectDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentInsight" ADD CONSTRAINT "DocumentInsight_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ProjectDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentJob" ADD CONSTRAINT "DocumentJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ProjectDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRetrieval" ADD CONSTRAINT "DocumentRetrieval_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Documents existants : déjà découpés et consultables ; ils passent à l'état final et leurs segments sont indexés.
UPDATE "ProjectDocument" SET "stage" = 'DONE', "indexedAt" = "updatedAt",
  "kind" = CASE WHEN "mimeType" = 'text/markdown' THEN 'MARKDOWN'::"DocumentKind" WHEN "mimeType" = 'text/csv' THEN 'CSV'::"DocumentKind" WHEN "mimeType" = 'application/json' THEN 'JSON'::"DocumentKind" ELSE 'TEXT'::"DocumentKind" END
  WHERE "status" = 'READY';
UPDATE "ProjectDocumentChunk" SET "tsv" = to_tsvector('french', iatrano_unaccent("content")),
  "lexCount" = 0;
UPDATE "ProjectDocumentChunk" c SET "lexCount" = (SELECT COALESCE(SUM(array_length(u.positions, 1)), 0) FROM unnest(c."tsv") u);
