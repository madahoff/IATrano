import "server-only";
import { searchFetch } from "./http";
import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from "./types";

// Brave Search API (https://api.search.brave.com/app/documentation/web-search) — clé requise (offre gratuite limitée).

type BraveResponse = {
  web?: { results?: Array<{ url?: string; title?: string; description?: string; page_age?: string; extra_snippets?: string[] }> };
};

const FRESHNESS: Record<NonNullable<SearchOptions["freshness"]>, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

export class BraveProvider implements SearchProvider {
  readonly kind = "BRAVE" as const;
  readonly label = "Brave Search";

  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(20, opts.count)));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("text_decorations", "false");
    if (opts.freshness) url.searchParams.set("freshness", FRESHNESS[opts.freshness]);
    const res = await searchFetch(url.toString(), { headers: { accept: "application/json", "x-subscription-token": this.apiKey } }, { ...opts, label: this.label });
    if (res.status === 401 || res.status === 403) throw new SearchError("Clé Brave Search refusée.", "unauthorized", "Vérifiez la clé dans Administration → Recherche Web.");
    if (res.status === 429) throw new SearchError("Quota Brave Search atteint (429).", "rate_limited", "Patientez ou augmentez votre offre Brave Search.");
    if (!res.ok) throw new SearchError(`Brave Search a répondu ${res.status}.`, "http_error");
    let data: BraveResponse;
    try {
      data = (await res.json()) as BraveResponse;
    } catch {
      throw new SearchError("Réponse Brave Search illisible.", "bad_response");
    }
    return (data.web?.results ?? [])
      .filter((r) => typeof r.url === "string" && r.url)
      .map((r) => ({
        url: r.url!,
        title: stripTags(r.title ?? ""),
        snippet: stripTags([r.description ?? "", ...(r.extra_snippets ?? []).slice(0, 2)].join(" ")),
        publishedAt: r.page_age ?? null,
        engine: "brave",
      }));
  }
}
