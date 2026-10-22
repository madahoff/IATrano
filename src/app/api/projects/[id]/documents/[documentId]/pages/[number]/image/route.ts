import { route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest, notFound } from "@/lib/errors";
import { db } from "@/lib/db";
import { getOwnedDocument } from "@/lib/documents/service";
import { fileSize, readStored } from "@/lib/documents/storage";
import { Readable } from "node:stream";

type Ctx = { params: Promise<{ id: string; documentId: string; number: string }> };

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Image rendue d'une page (OCR) ou image clé : servie avec un type fixe, jamais interprétée comme HTML. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  const n = Number(p.number);
  if (!Number.isInteger(n) || n < 1) throw badRequest("Numéro de page invalide.");
  await getOwnedDocument(user.id, p.id, p.documentId);
  const page = await db.documentPage.findUnique({ where: { documentId_number: { documentId: p.documentId, number: n } }, select: { imagePath: true } });
  const ext = page?.imagePath?.split(".").pop()?.toLowerCase() ?? "";
  if (!page?.imagePath || !TYPES[ext]) throw notFound("Aucune image pour cette page.");
  const size = await fileSize(page.imagePath).catch(() => null);
  if (size === null) throw notFound("Image introuvable.");
  return new Response(Readable.toWeb(readStored(page.imagePath)) as ReadableStream, {
    headers: { "content-type": TYPES[ext], "content-length": String(size), "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
  });
});
