import { Readable } from "node:stream";
import { route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { readStored } from "@/lib/documents/storage";
import { chatFilePdfPage, getOwnedChatFile, PDF_PAGE_DPI } from "@/lib/files/chat-files";

type Ctx = { params: Promise<{ id: string; number: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 130;

/** Page d'un PDF rendue en PNG (?scale=1|2|3), pour la visionneuse intégrée (fonctionne aussi sur mobile). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  const f = await getOwnedChatFile(user.id, p.id);
  const requested = Number(new URL(req.url).searchParams.get("scale") ?? 2);
  const scale = (requested in PDF_PAGE_DPI ? requested : 2) as keyof typeof PDF_PAGE_DPI;
  const file = await chatFilePdfPage(f, Number(p.number), scale);
  return new Response(Readable.toWeb(readStored(file)) as ReadableStream, {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" },
  });
});
