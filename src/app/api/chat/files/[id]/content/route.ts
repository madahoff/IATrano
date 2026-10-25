import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { notFound } from "@/lib/errors";
import { readStored, resolveStored } from "@/lib/documents/storage";
import { getOwnedChatFile, saveChatFileDocx, saveChatFileText } from "@/lib/files/chat-files";
import { CHAT_FILE_MAX_BYTES } from "@/lib/files/types";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

// Types affichables dans le navigateur (PDF, images, vidéo/audio) ; les textes sont servis en text/plain (jamais
// interprétés) ; tout le reste est téléchargé.
const INLINE = /^(application\/pdf|image\/(png|jpeg|webp|gif|bmp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|mp4|ogg))$/;
const TEXT_KINDS = new Set(["TEXT", "MARKDOWN", "JSON", "CSV"]);

/** Fichier original, dernière version (requêtes Range prises en charge : lecture audio / vidéo). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const f = await getOwnedChatFile(user.id, (await params).id);
  const size = await stat(/* turbopackIgnore: true */ resolveStored(f.storagePath)).then((s) => s.size, () => null);
  if (size === null) throw notFound("Fichier introuvable sur le serveur.");
  const download = new URL(req.url).searchParams.get("download") === "1";
  const asText = TEXT_KINDS.has(f.kind) && !download;
  const inline = !download && (asText || INLINE.test(f.mimeType));
  const headers: Record<string, string> = {
    "content-type": asText ? "text/plain; charset=utf-8" : inline ? f.mimeType : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    etag: `"${f.checksum.slice(0, 32)}"`,
    "x-file-version": String(f.version),
  };
  // Aucun script possible dans l'origine de l'application. Les PDF sont affichés par la visionneuse du navigateur
  // (isolée), qui refuse de s'ouvrir dans un contexte « sandbox ».
  if (f.mimeType !== "application/pdf" || !inline) headers["content-security-policy"] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(Readable.toWeb(readStored(f.storagePath, { start, end })) as ReadableStream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(readStored(f.storagePath)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
});

const saveSchema = z.union([
  z.object({ baseVersion: z.number().int().positive(), text: z.string().max(CHAT_FILE_MAX_BYTES) }),
  z.object({ baseVersion: z.number().int().positive(), edits: z.array(z.object({ index: z.number().int().min(0), text: z.string().max(100_000) })).min(1).max(20_000) }),
]);

/** Enregistre une modification : texte complet (texte, Markdown, JSON, CSV) ou paragraphes modifiés (Word). */
export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const id = (await params).id;
  const body = await parseJson(req, saveSchema);
  const saved = "edits" in body ? await saveChatFileDocx(user.id, id, body.baseVersion, body.edits) : await saveChatFileText(user.id, id, body.baseVersion, body.text);
  return json(saved);
});
