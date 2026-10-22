import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { repairArtifact } from "@/lib/artifacts/service";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 600;

// « Régénérer l'artifact » : l'erreur constatée dans l'aperçu est renvoyée à Qwen avec le code ;
// une nouvelle version corrigée est enregistrée. `auto` : tentative automatique (une seule par version).
const schema = z.object({
  problem: z.string().trim().min(1, "Décrivez le problème.").max(4000),
  auto: z.boolean().default(false),
});

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const limit = rateLimit(`gen:${user.id}`, env().RATE_LIMIT_GENERATIONS_PER_MINUTE, 60_000);
  if (!limit.ok) throw tooManyRequests(limit.retryAfterSec);
  const input = await parseJson(req, schema);
  const artifact = await repairArtifact({ userId: user.id, id: (await params).id, problem: input.problem, auto: input.auto, signal: req.signal });
  return json({ artifact });
});
