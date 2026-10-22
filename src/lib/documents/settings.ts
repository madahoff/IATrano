import "server-only";
import type { DocumentSettings } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { normalizeBaseUrl } from "@/lib/llm/url";

// Réglages de la bibliothèque documentaire (ligne unique). Les valeurs initiales peuvent venir de l'environnement :
// DOCUMENT_EMBEDDING_MODEL, DOCUMENT_TRANSCRIPTION_URL, DOCUMENT_VISION_MODEL.

let cache: { at: number; value: DocumentSettings } | null = null;

export async function getDocumentSettings(): Promise<DocumentSettings> {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  let value = await db.documentSettings.findUnique({ where: { id: 1 } });
  value ??= await db.documentSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      embeddingModel: process.env.DOCUMENT_EMBEDDING_MODEL || null,
      transcriptionUrl: process.env.DOCUMENT_TRANSCRIPTION_URL || null,
      transcriptionModel: process.env.DOCUMENT_TRANSCRIPTION_MODEL || null,
      visionModel: process.env.DOCUMENT_VISION_MODEL || null,
    },
  });
  cache = { at: Date.now(), value };
  return value;
}

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    const check = normalizeBaseUrl(v);
    if (!check.ok) {
      ctx.addIssue({ code: "custom", message: check.error });
      return z.NEVER;
    }
    return check.url;
  });
const optionalName = z.string().trim().max(200).nullable().transform((v) => v || null);

export const documentSettingsSchema = z
  .object({
    embeddingModel: optionalName,
    embeddingBaseUrl: optionalUrl,
    ocrEnabled: z.boolean(),
    ocrLanguages: z.string().trim().regex(/^[a-z_]{3,8}(\+[a-z_]{3,8}){0,4}$/, "Langues OCR au format tesseract, par exemple fra+eng."),
    visionModel: optionalName,
    transcriptionUrl: optionalUrl,
    transcriptionModel: optionalName,
    analysisEnabled: z.boolean(),
    analysisModel: optionalName,
    chunkTargetTokens: z.number().int().min(150).max(2000),
    chunkOverlapTokens: z.number().int().min(0).max(400),
    maxFileMb: z.number().int().min(1).max(4096),
    maxUnits: z.number().int().min(10).max(20_000),
    concurrency: z.number().int().min(1).max(4),
    retrievalMaxPassages: z.number().int().min(3).max(40),
  })
  .partial();

export async function updateDocumentSettings(input: z.infer<typeof documentSettingsSchema>, userId: string) {
  await getDocumentSettings();
  const value = await db.documentSettings.update({ where: { id: 1 }, data: { ...input, updatedById: userId } });
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateDocumentSettings() {
  cache = null;
}
