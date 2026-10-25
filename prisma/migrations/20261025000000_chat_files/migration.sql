-- CreateTable
CREATE TABLE "ChatFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "name" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "pageCount" INTEGER,
    "text" TEXT NOT NULL DEFAULT '',
    "warning" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatFile_userId_createdAt_idx" ON "ChatFile"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatFile_conversationId_idx" ON "ChatFile"("conversationId");

-- AddForeignKey
ALTER TABLE "ChatFile" ADD CONSTRAINT "ChatFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatFile" ADD CONSTRAINT "ChatFile_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

