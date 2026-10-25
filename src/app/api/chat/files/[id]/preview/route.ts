import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { chatFilePreview, getOwnedChatFile } from "@/lib/files/chat-files";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Aperçu structuré : paragraphes d'un document Word, feuilles d'un classeur, texte des diapositives. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const f = await getOwnedChatFile(user.id, (await params).id);
  return json(await chatFilePreview(f));
});
