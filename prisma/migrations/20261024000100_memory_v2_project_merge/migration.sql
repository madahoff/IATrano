-- Mémoire persistante v2 (2/2) : la mémoire de projet rejoint la table Memory (portée projectId).

INSERT INTO "Memory" ("id", "userId", "projectId", "kind", "content", "source", "certainty", "sourceDocumentId", "sourceConversationId", "importance", "createdAt", "updatedAt", "lastConfirmedAt")
SELECT pm."id", p."userId", pm."projectId",
  (CASE pm."kind"::text
    WHEN 'OBJECTIVE' THEN 'OBJECTIVE'
    WHEN 'CONSTRAINT' THEN 'CONSTRAINT'
    WHEN 'DECISION' THEN 'DECISION'
    WHEN 'CONCLUSION' THEN 'DECISION'
    ELSE 'FACT' END)::"MemoryKind",
  pm."content",
  (CASE pm."source"::text WHEN 'DOCUMENT' THEN 'DOCUMENT' WHEN 'AI' THEN 'AUTO' ELSE 'MANUAL' END)::"MemorySource",
  (CASE pm."source"::text WHEN 'AI' THEN 'STATED' ELSE 'CONFIRMED' END)::"MemoryCertainty",
  pm."sourceDocumentId", pm."sourceConversationId", 3, pm."createdAt", pm."updatedAt", pm."updatedAt"
FROM "ProjectMemory" pm
JOIN "Project" p ON p."id" = pm."projectId";

-- DropForeignKey
ALTER TABLE "ProjectMemory" DROP CONSTRAINT "ProjectMemory_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ProjectMemory" DROP CONSTRAINT "ProjectMemory_sourceDocumentId_fkey";

-- DropTable
DROP TABLE "ProjectMemory";

-- DropEnum
DROP TYPE "ProjectMemoryKind";

-- DropEnum
DROP TYPE "ProjectMemorySource";

