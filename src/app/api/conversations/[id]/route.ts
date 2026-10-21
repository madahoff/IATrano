import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { notFound } from "@/lib/errors";
import { deleteConversation, getConversationWithMessages, updateConversation } from "@/lib/chat/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const conv = await getConversationWithMessages(user.id, (await params).id);
  if (!conv) throw notFound("Conversation introuvable.");
  return json({ conversation: conv });
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1, "Le titre est vide.").max(120).optional(),
    archived: z.boolean().optional(),
    model: z.string().min(1).max(200).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "Aucune modification.");

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const data = await parseJson(req, patchSchema);
  return json({ conversation: await updateConversation(user.id, (await params).id, data) });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  await deleteConversation(user.id, (await params).id);
  return json({ ok: true });
});
