import { Readable } from "node:stream";
import { route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { notFound } from "@/lib/errors";
import { readStored } from "@/lib/documents/storage";
import { chatFileThumbnail, getOwnedChatFile } from "@/lib/files/chat-files";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Miniature (première page d'un PDF, image réduite, image d'une vidéo). 404 : l'interface affiche une icône. */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const f = await getOwnedChatFile(user.id, (await params).id);
  const thumb = await chatFileThumbnail(f);
  if (!thumb) throw notFound("Aucune miniature pour ce fichier.");
  return new Response(Readable.toWeb(readStored(thumb.path)) as ReadableStream, {
    headers: {
      "content-type": thumb.mime,
      // Avec la version dans l'URL (?v=), la miniature ne change jamais ; sans elle (messages), revalidation à chaque fois.
      "cache-control": new URL(req.url).searchParams.has("v") ? "private, max-age=86400" : "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
});
