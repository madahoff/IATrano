import { Readable } from "node:stream";
import { route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { notFound } from "@/lib/errors";
import { getOwnedDocument } from "@/lib/documents/service";
import { fileSize, readStored } from "@/lib/documents/storage";

type Ctx = { params: Promise<{ id: string; documentId: string }> };

// Types affichables dans le navigateur (PDF, images, vidéo/audio) : les autres sont toujours téléchargés.
const INLINE = /^(application\/pdf|image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|wav|mp4|ogg))$/;

/** Fichier original (requêtes Range prises en charge : lecture d'une vidéo à un horodatage). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  const doc = await getOwnedDocument(user.id, p.id, p.documentId);
  if (!doc.storagePath) throw notFound("Le fichier original n'est pas conservé pour ce document (import antérieur).");
  const size = await fileSize(doc.storagePath).catch(() => null);
  if (size === null) throw notFound("Fichier original introuvable.");
  const inline = INLINE.test(doc.mimeType) && new URL(req.url).searchParams.get("download") !== "1";
  const headers: Record<string, string> = {
    "content-type": inline ? doc.mimeType : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  // Image, vidéo, fichier téléchargé : aucun script possible dans l'origine de l'application. Les PDF sont
  // affichés par la visionneuse du navigateur (isolée), qui refuse de s'ouvrir dans un contexte « sandbox ».
  if (doc.mimeType !== "application/pdf" || !inline) headers["content-security-policy"] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(Readable.toWeb(readStored(doc.storagePath, { start, end })) as ReadableStream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(readStored(doc.storagePath)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
});
