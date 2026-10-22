import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { getModels } from "@/lib/llm/discovery";
import { getAppSettings } from "@/lib/settings/service";
import { AUTH_MODES, ROUTING_MODES } from "@/lib/routing/config";
import { effectiveAuthMode, proposeRouting } from "@/lib/routing/service";

// Étape 1 d'un envoi : JEV analyse la demande et propose des modes. Si une confirmation est nécessaire,
// le navigateur affiche la carte, puis appelle /api/chat avec la décision et le choix de l'utilisateur.
// Ne bloque jamais : si JEV est injoignable, le mode de repli est proposé.
const override = z.enum(["on", "off"]).optional();
const schema = z.object({
  conversationId: z.string().min(1).max(64).nullable().optional(),
  content: z.string().trim().min(1, "Le message est vide.").max(32_000, "Message trop long (32 000 caractères max)."),
  anchorMessageId: z.string().min(1).max(64).nullable().optional(),
  model: z.string().min(1).max(200),
  authMode: z.enum(AUTH_MODES).optional(),
  overrides: z.object(Object.fromEntries(ROUTING_MODES.map((m) => [m, override])) as Record<(typeof ROUTING_MODES)[number], typeof override>).default({}),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const body = await parseJson(req, schema);
  const limit = rateLimit(`routing:${user.id}`, env().RATE_LIMIT_GENERATIONS_PER_MINUTE * 2, 60_000);
  if (!limit.ok) throw tooManyRequests(limit.retryAfterSec);
  const [app, snapshot] = await Promise.all([getAppSettings(), getModels()]);
  const proposal = await proposeRouting({
    userId: user.id,
    conversationId: body.conversationId ?? null,
    content: body.content,
    anchorMessageId: body.anchorMessageId,
    authMode: body.authMode ?? (await effectiveAuthMode(user.id)),
    overrides: body.overrides,
    app,
    model: snapshot.models.find((m) => m.id === body.model) ?? null,
  });
  return json(proposal);
});
