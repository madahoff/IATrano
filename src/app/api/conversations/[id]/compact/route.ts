import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { compactConversation } from "@/lib/context/compact";
import { computeContextUsage } from "@/lib/context/service";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ model: z.string().min(1, "Aucun modèle sélectionné.").max(200) });

/** Compaction manuelle : résume les anciens échanges dans le contexte actif (l'historique reste intact). */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const { model } = await parseJson(req, schema);
  const limit = rateLimit(`compact:${user.id}`, 6, 60_000);
  if (!limit.ok) throw tooManyRequests(limit.retryAfterSec);
  const id = (await params).id;
  const result = await compactConversation({ userId: user.id, conversationId: id, modelId: model, trigger: "manual", signal: req.signal });
  return json({ result, usage: await computeContextUsage(user.id, id, model) });
});
