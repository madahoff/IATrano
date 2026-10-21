import { z } from "zod";
import { env } from "@/lib/env";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest, tooManyRequests } from "@/lib/errors";
import { normalizeBaseUrl } from "@/lib/llm/url";
import { buildProvider } from "@/lib/llm/registry";
import { getAppSettings } from "@/lib/settings/service";
import { rateLimit } from "@/lib/rate-limit";

// Teste une configuration (enregistrée ou non) depuis le serveur Next.js — c'est lui qui joint le moteur IA.
const schema = z.object({
  providerType: z.enum(["OLLAMA", "OPENAI_COMPATIBLE"]).optional(),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const r = rateLimit(`ai-test:${user.id}`, 20, 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const input = await parseJson(req, schema);
  const saved = await getAppSettings();
  const check = normalizeBaseUrl(input.baseUrl ?? saved.baseUrl, env().AI_URL_ALLOWLIST);
  if (!check.ok) throw badRequest(check.error, "invalid_url");
  const provider = buildProvider({
    kind: input.providerType ?? saved.providerType,
    baseUrl: check.url,
    apiKey: input.apiKey === undefined ? saved.apiKey : input.apiKey || null,
    timeoutMs: 8000,
  });
  const result = await provider.testConnection();
  const models = result.ok ? await provider.listModels().catch(() => []) : [];
  return json({ result, models });
});
