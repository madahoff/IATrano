import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { getAppSettings } from "@/lib/settings/service";
import { logEvent } from "@/lib/logger";
import { extractPage, extractPlain } from "@/lib/search/extract";
import { createSearchProvider, searchConfigFrom } from "@/lib/search/providers";
import { SearchError } from "@/lib/search/providers/types";
import { FetchBlockedError, safeFetch, validatePublicUrl } from "@/lib/search/safe-fetch";

// Test réel d'une configuration de recherche (enregistrée ou saisie) : requête au moteur puis lecture de quelques pages.
const schema = z.object({
  searchProvider: z.enum(["SEARXNG", "BRAVE"]).optional(),
  searxngUrl: z.string().max(500).optional(),
  braveApiKey: z.string().max(200).optional(),
  searchFallbackEnabled: z.boolean().optional(),
  query: z.string().trim().min(2).max(200).default("actualités intelligence artificielle"),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const r = rateLimit(`search-test:${user.id}`, 10, 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const input = await parseJson(req, schema);
  const saved = await getAppSettings();
  const config = searchConfigFrom({
    searchProvider: input.searchProvider ?? saved.searchProvider,
    searxngUrl: input.searxngUrl === undefined ? saved.searxngUrl : input.searxngUrl || null,
    braveApiKey: input.braveApiKey === undefined ? saved.braveApiKey : input.braveApiKey || null,
    searchFallbackEnabled: input.searchFallbackEnabled ?? saved.searchFallbackEnabled,
  });
  const start = Date.now();
  try {
    const provider = createSearchProvider(config);
    const results = await provider.search(input.query, { count: saved.searchMaxResults, timeoutMs: saved.searchTimeoutMs });
    const searchMs = Date.now() - start;
    const toRead = results.filter((x) => validatePublicUrl(x.url).ok).slice(0, Math.min(3, saved.searchMaxPages));
    const pages = await Promise.all(
      toRead.map(async (x) => {
        const t = Date.now();
        try {
          const page = await safeFetch(x.url, { timeoutMs: 8000 });
          const ext = page.contentType.includes("text/plain") ? extractPlain(page.body) : extractPage(page.body, page.finalUrl);
          return { url: x.url, ok: true, chars: ext.textLength, title: ext.title, publishedAt: ext.publishedAt, ms: Date.now() - t };
        } catch (err) {
          return { url: x.url, ok: false, error: err instanceof FetchBlockedError ? err.message : "Échec de la récupération", ms: Date.now() - t };
        }
      }),
    );
    return json({
      ok: true,
      provider: provider.label,
      latencyMs: searchMs,
      resultCount: results.length,
      results: results.slice(0, 8).map((x) => ({ title: x.title, url: x.url, engine: x.engine ?? null, publishedAt: x.publishedAt })),
      pages,
    });
  } catch (err) {
    const e = err instanceof SearchError ? err : new SearchError("Erreur inattendue pendant le test.", "bad_response");
    await logEvent("WARN", "search:test", e.message, { code: e.code, provider: config.kind }, user.id);
    return json({ ok: false, latencyMs: Date.now() - start, error: e.message, hint: e.hint, code: e.code });
  }
});
