import { z } from "zod";
import { parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { encodeEvent, type StreamEvent } from "@/lib/chat/protocol";
import { prepareGeneration, resolveModel, runGeneration } from "@/lib/chat/generate";
import { getAppSettings } from "@/lib/settings/service";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const schema = z.object({
  action: z.enum(["send", "regenerate", "edit"]),
  conversationId: z.string().min(1).max(64).optional(),
  content: z.string().max(32_000, "Message trop long (32 000 caractères max).").optional(),
  messageId: z.string().min(1).max(64).optional(),
  model: z.string().min(1, "Aucun modèle sélectionné.").max(200),
  thinking: z.boolean().default(false),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const body = await parseJson(req, schema);
  const limit = rateLimit(`gen:${user.id}`, env().RATE_LIMIT_GENERATIONS_PER_MINUTE, 60_000);
  if (!limit.ok) throw tooManyRequests(limit.retryAfterSec);

  const resolved = await resolveModel(body.model, body.thinking);
  const settings = await getAppSettings();
  const prepared = await prepareGeneration(user.id, body, body.model, resolved.thinkingEffective, settings.providerType);

  // L'annulation côté navigateur (AbortController) ferme la requête : on interrompt alors l'appel au fournisseur.
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          open = false;
        }
      };
      try {
        await runGeneration({ userId: user.id, prepared, resolved, modelId: body.model, signal: abort.signal, emit });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
