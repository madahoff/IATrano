import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { modesConfigSchema, ROUTING_MODES } from "@/lib/routing/config";
import { getRoutingSettings, routingConfigFrom } from "@/lib/routing/service";
import { buildJevState } from "@/lib/routing/jev-state";
import { safeJevDecide } from "@/lib/jev/service";

// Zone de test : probabilités de JEV pour un message, avec les questions du formulaire (enregistrées ou non).
// La décision selon chaque mode d'autorisation est calculée dans le navigateur (même fonction que le serveur).
const schema = z.object({
  message: z.string().trim().min(1, "Saisissez un message.").max(32_000),
  modes: modesConfigSchema.optional(),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const r = rateLimit(`routing-test:${user.id}`, 30, 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const input = await parseJson(req, schema);
  const modes = input.modes ?? routingConfigFrom(await getRoutingSettings()).modes;
  const result = await safeJevDecide(buildJevState(input.message, [], false), ROUTING_MODES.map((m) => ({ name: m, instructions: modes[m].question })));
  if (!result.ok) return json({ ok: false, error: result.error, hint: result.hint });
  return json({ ok: true, probabilities: result.decision.answers, model: result.decision.model, latencyMs: result.decision.timing.totalMs, serverMs: result.decision.timing.serverMs });
});
