import "server-only";
import type { AppSettings } from "@prisma/client";
import { env } from "@/lib/env";
import { normalizeBaseUrl } from "@/lib/llm/url";
import { BraveProvider } from "./brave";
import { SearxngProvider } from "./searxng";
import { SearchError, type SearchProvider, type SearchProviderKind } from "./types";

export const SEARCH_PROVIDER_LABELS: Record<SearchProviderKind, string> = {
  SEARXNG: "SearXNG (auto-hébergé)",
  BRAVE: "Brave Search API",
};

export type SearchConfig = {
  kind: SearchProviderKind;
  searxngUrl: string | null;
  braveApiKey: string | null;
};

/** Configuration effective : valeurs de l'administration, sinon variables d'environnement. */
export function searchConfigFrom(s: Pick<AppSettings, "searchProvider" | "searxngUrl" | "braveApiKey">): SearchConfig {
  const e = env();
  return {
    kind: s.searchProvider,
    searxngUrl: s.searxngUrl || e.SEARXNG_URL || null,
    braveApiKey: s.braveApiKey || e.BRAVE_SEARCH_API_KEY || null,
  };
}

/** Moteur prêt à l'emploi, ou SearchError « not_configured » expliquant ce qui manque. */
export function createSearchProvider(config: SearchConfig): SearchProvider {
  if (config.kind === "BRAVE") {
    if (!config.braveApiKey) throw new SearchError("Aucune clé Brave Search n'est configurée.", "not_configured", "Renseignez la clé dans Administration → Recherche Web ou via BRAVE_SEARCH_API_KEY.");
    return new BraveProvider(config.braveApiKey);
  }
  if (!config.searxngUrl) throw new SearchError("Aucune adresse SearXNG n'est configurée.", "not_configured", "Renseignez l'adresse dans Administration → Recherche Web ou via SEARXNG_URL.");
  const check = normalizeBaseUrl(config.searxngUrl);
  if (!check.ok) throw new SearchError(`Adresse SearXNG invalide : ${check.error}`, "not_configured");
  return new SearxngProvider(check.url);
}

export function isSearchConfigured(config: SearchConfig): boolean {
  return config.kind === "BRAVE" ? Boolean(config.braveApiKey) : Boolean(config.searxngUrl);
}
