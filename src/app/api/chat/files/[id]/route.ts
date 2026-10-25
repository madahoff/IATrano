import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { discardUnsentChatFile, getOwnedChatFile, toChatFileDTO } from "@/lib/files/chat-files";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Métadonnées d'un fichier joint (propriétaire uniquement). */
export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json(await toChatFileDTO(await getOwnedChatFile(user.id, (await params).id)));
});

/** Retrait depuis la zone de saisie : le fichier n'est supprimé que s'il n'a jamais été envoyé. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  await discardUnsentChatFile(user.id, (await params).id);
  return json({ ok: true });
});
