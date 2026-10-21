import "server-only";
import { searchFetch } from "./http";
import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from "./types";

// SearXNG (auto-hébergeable) : API JSON /search?format=json. Le format json doit être activé
// dans settings.yml (search.formats), sinon SearXNG répond 403.

type SearxResponse = {
  results?: Array<{ url?: string; title?: string; content?: string; publishedDate?: string | null; engine?: string; engines?: string[] }>;
  unresponsive_engines?: Array<[string, string]>;
};

const TIME_RANGE: Record<NonNullable<SearchOptions["freshness"]>, string> = { day: "day", week: "week", month: "month", year: "year" };

export class SearxngProvider implements SearchProvider {
  readonly kind = "SEARXNG" as const;
  readonly label = "SearXNG";

  constructor(private readonly baseUrl: string) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");
    if (opts.language) url.searchParams.set("language", opts.language);
    if (opts.freshness) url.searchParams.set("time_range", TIME_RANGE[opts.freshness]);
    const res = await searchFetch(url.toString(), { headers: { accept: "application/json" } }, { ...opts, label: this.label });
    if (res.status === 403) {
      throw new SearchError("SearXNG refuse le format JSON (403).", "http_error", "Ajoutez « json » à search.formats dans settings.yml de SearXNG (voir searxng/settings.yml du dépôt).");
    }
    if (res.status === 429) throw new SearchError("SearXNG limite le nombre de requêtes (429).", "rate_limited", "Désactivez server.limiter pour une instance privée réservée à IATrano.");
    if (!res.ok) throw new SearchError(`SearXNG a répondu ${res.status}.`, "http_error");
    let data: SearxResponse;
    try {
      data = (await res.json()) as SearxResponse;
    } catch {
      throw new SearchError("Réponse SearXNG illisible (JSON attendu).", "bad_response", "L'adresse configurée pointe-t-elle bien vers SearXNG ?");
    }
    if (!Array.isArray(data.results)) throw new SearchError("Réponse SearXNG inattendue.", "bad_response");
    return data.results
      .filter((r) => typeof r.url === "string" && r.url)
      .slice(0, opts.count * 2)
      .map((r) => ({
        url: r.url!,
        title: (r.title ?? "").trim(),
        snippet: (r.content ?? "").replace(/\s+/g, " ").trim(),
        publishedAt: r.publishedDate ?? null,
        engine: r.engine ?? r.engines?.[0],
      }));
  }
}
