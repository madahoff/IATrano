import { z } from "zod";
import { parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { encodeEvent, type StreamEvent } from "@/lib/chat/protocol";
import { prepareGeneration, resolveModel, runGeneration } from "@/lib/chat/generate";
import { getEffectivePreferences } from "@/lib/settings/service";
import { ROUTING_MODES } from "@/lib/routing/config";
import { attachRouting, resolveRouting } from "@/lib/routing/service";
import { latestVersion } from "@/lib/artifacts/service";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const schema = z.object({
  action: z.enum(["send", "regenerate", "edit"]),
  conversationId: z.string().min(1).max(64).optional(),
  content: z.string().max(32_000, "Message trop long (32 000 caractères max).").optional(),
  messageId: z.string().min(1).max(64).optional(),
  model: z.string().min(1, "Aucun modèle sélectionné.").max(200),
  thinking: z.boolean().default(false),
  webSearch: z.boolean().optional(),
  projectId: z.string().min(1).nullable().optional(),
  artifactKey: z.string().min(1).max(64).optional(),
  routing: z
    .object({
      decisionId: z.string().min(1).max(64),
      choice: z.enum(["accept", "reject", "always"]).optional(),
      accepted: z.array(z.enum(ROUTING_MODES)).max(3).optional(),
    })
    .optional(),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const body = await parseJson(req, schema);
  const limit = rateLimit(`gen:${user.id}`, env().RATE_LIMIT_GENERATIONS_PER_MINUTE, 60_000);
  if (!limit.ok) throw tooManyRequests(limit.retryAfterSec);

  // Routage JEV : les modes viennent de la décision enregistrée (proposée par /api/chat/routing), jamais du navigateur.
  const routing = body.routing ? await resolveRouting(user.id, body.routing) : null;
  const resolved = await resolveModel(body.model, routing ? routing.modes.includes("thinking") : body.thinking);
  const prefs = await getEffectivePreferences(user.id);
  const prepared = await prepareGeneration(
    user.id,
    // Avec routage, le contrôle Recherche persistant de la conversation n'est pas modifié.
    routing ? { ...body, webSearch: undefined } : body,
    body.model,
    resolved.thinkingEffective,
    prefs.app.providerType,
    prefs.webSearchDefault,
  );
  if (routing) await attachRouting(routing, prepared.conversation.id, prepared.assistantMessage.id);
  // Modification de la page ouverte : seulement si le mode interactif est retenu (il peut être interdit par l'administration).
  const interactive = routing?.modes.includes("interactive") ?? false;
  const editTarget = interactive && body.artifactKey ? await latestVersion(user.id, prepared.conversation.id, body.artifactKey) : null;

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
        await runGeneration({
          userId: user.id,
          prepared,
          resolved,
          modelId: body.model,
          signal: abort.signal,
          emit,
          routing: routing
            ? {
                snapshot: routing.snapshot,
                research: routing.modes.includes("research"),
                interactive,
                artifactEdit: editTarget ? { key: editTarget.key, title: editTarget.title, version: editTarget.version, code: editTarget.code } : null,
              }
            : null,
        });
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
