import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { getAppSettings } from "@/lib/settings/service";
import { createSearchProvider, hasSearchFallback, SEARCH_PROVIDER_LABELS, searchConfigFrom } from "@/lib/search/providers";
import { BraveProvider } from "@/lib/search/providers/brave";
import { SearchError } from "@/lib/search/providers/types";
import { runSearchDiagnostics } from "@/lib/search/diagnostics";
import { recordTestRun } from "@/lib/diagnostics/history";

// Diagnostic du service de recherche Web enregistré (Administration → Recherche Web).
export const POST = route(async () => {
  const user = await requireApiUser("settings:manage");
  const r = rateLimit(`search-diagnose:${user.id}`, 5, 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const settings = await getAppSettings();
  const config = searchConfigFrom(settings);
  let provider;
  try {
    // Principal testé seul : le secours fait l'objet d'une étape distincte.
    provider = createSearchProvider({ ...config, fallback: false });
  } catch (err) {
    provider = err instanceof SearchError ? err : new SearchError(String(err), "not_configured");
  }
  const report = await runSearchDiagnostics(
    {
      kind: config.kind,
      label: SEARCH_PROVIDER_LABELS[config.kind],
      endpoint: config.kind === "BRAVE" ? "https://api.search.brave.com" : (config.searxngUrl ?? ""),
      apiKey: config.braveApiKey,
      timeoutMs: settings.searchTimeoutMs,
      maxResults: settings.searchMaxResults,
    },
    { provider, backup: hasSearchFallback(config) ? new BraveProvider(config.braveApiKey!) : null },
  );
  await recordTestRun(report, user.id);
  return json({ report });
});
