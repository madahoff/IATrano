import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { normalizeBaseUrl } from "@/lib/llm/url";
import { invalidateModelCache } from "@/lib/llm/discovery";
import { getAppSettings, publicAppSettings } from "@/lib/settings/service";
import { logEvent } from "@/lib/logger";
import { clearSearchCaches } from "@/lib/search/pipeline";

export const GET = route(async () => {
  await requireApiUser("settings:manage");
  return json({ settings: publicAppSettings(await getAppSettings()) });
});

const schema = z.object({
  providerType: z.enum(["OLLAMA", "OPENAI_COMPATIBLE"]).optional(),
  baseUrl: z.string().max(500).optional(),
  // undefined : inchangé ; "" : supprimer ; valeur : remplacer
  apiKey: z.string().max(500).optional(),
  defaultModel: z.string().max(200).nullable().optional(),
  thinkingDefault: z.boolean().optional(),
  clarificationsEnabled: z.boolean().optional(),
  systemPrompt: z.string().max(8000).optional(),
  requestTimeoutMs: z.number().int().min(5_000).max(900_000).optional(),
  webSearchEnabled: z.boolean().optional(),
  webSearchAutoDefault: z.boolean().optional(),
  searchProvider: z.enum(["SEARXNG", "BRAVE"]).optional(),
  // "" : utiliser SEARXNG_URL
  searxngUrl: z.string().max(500).optional(),
  // undefined : inchangée ; "" : supprimer ; valeur : remplacer
  braveApiKey: z.string().max(200).optional(),
  searchMaxResults: z.number().int().min(1).max(20).optional(),
  searchMaxPages: z.number().int().min(1).max(8).optional(),
  searchTimeoutMs: z.number().int().min(5_000).max(60_000).optional(),
  searchCacheTtlSec: z.number().int().min(0).max(86_400).optional(),
});

export const PATCH = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const input = await parseJson(req, schema);
  await getAppSettings();
  let baseUrl: string | undefined;
  if (input.baseUrl !== undefined) {
    const check = normalizeBaseUrl(input.baseUrl, env().AI_URL_ALLOWLIST);
    if (!check.ok) throw badRequest(check.error, "invalid_url");
    baseUrl = check.url;
  }
  let searxngUrl: string | null | undefined;
  if (input.searxngUrl !== undefined) {
    if (!input.searxngUrl.trim()) searxngUrl = null;
    else {
      const check = normalizeBaseUrl(input.searxngUrl);
      if (!check.ok) throw badRequest(check.error.replace("serveur IA", "service SearXNG"), "invalid_url");
      searxngUrl = check.url;
    }
  }
  const updated = await db.appSettings.update({
    where: { id: 1 },
    data: {
      providerType: input.providerType,
      baseUrl,
      apiKey: input.apiKey === undefined ? undefined : input.apiKey.trim() || null,
      defaultModel: input.defaultModel === undefined ? undefined : input.defaultModel || null,
      thinkingDefault: input.thinkingDefault,
      clarificationsEnabled: input.clarificationsEnabled,
      systemPrompt: input.systemPrompt === undefined ? undefined : input.systemPrompt.trim() || null,
      requestTimeoutMs: input.requestTimeoutMs,
      webSearchEnabled: input.webSearchEnabled,
      webSearchAutoDefault: input.webSearchAutoDefault,
      searchProvider: input.searchProvider,
      searxngUrl,
      braveApiKey: input.braveApiKey === undefined ? undefined : input.braveApiKey.trim() || null,
      searchMaxResults: input.searchMaxResults,
      searchMaxPages: input.searchMaxPages,
      searchTimeoutMs: input.searchTimeoutMs,
      searchCacheTtlSec: input.searchCacheTtlSec,
      updatedById: user.id,
    },
  });
  invalidateModelCache();
  // Nouvelle configuration de recherche : on ne réutilise pas des résultats obtenus avec l'ancienne.
  if (input.searchProvider !== undefined || input.searxngUrl !== undefined || input.braveApiKey !== undefined || input.searchCacheTtlSec !== undefined) clearSearchCaches();
  await logEvent("INFO", "admin:settings", `Configuration IA modifiée par ${user.email}`, {
    providerType: updated.providerType,
    baseUrl: updated.baseUrl,
    defaultModel: updated.defaultModel,
    webSearchEnabled: updated.webSearchEnabled,
    searchProvider: updated.searchProvider,
    searxngUrl: updated.searxngUrl,
    braveKeyChanged: input.braveApiKey !== undefined,
  }, user.id);
  return json({ settings: publicAppSettings(updated) });
});
