import { z } from "zod";
import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { computeContextUsage } from "@/lib/context/service";

export const dynamic = "force-dynamic";

const query = z.object({
  model: z.string().min(1, "Aucun modèle sélectionné.").max(200),
  conversationId: z.string().min(1).max(64).optional(),
});

/** Consommation du contexte que la prochaine génération occupera (conversation existante ou nouvelle). */
export const GET = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = query.safeParse(params);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Paramètres invalides.");
  // La conversation est cherchée avec userId : celle d'un autre compte renvoie 404.
  return json({ usage: await computeContextUsage(user.id, parsed.data.conversationId ?? null, parsed.data.model) });
});
