import "server-only";
import type { AppSettings } from "@prisma/client";
import { env } from "@/lib/env";
import { normalizeBaseUrl } from "@/lib/llm/url";
import { BraveProvider } from "./brave";
import { SearxngProvider } from "./searxng";
import { FallbackSearchProvider } from "./fallback";
import { SearchError, type SearchProvider, type SearchProviderKind } from "./types";

export const DEFAULT_SEARXNG_URL = "http://localhost:8888";

export const SEARCH_PROVIDER_LABELS: Record<SearchProviderKind, string> = {
  SEARXNG: "SearXNG (auto-hébergé)",
  BRAVE: "Brave Search API",
};

export type SearchConfig = {
  kind: SearchProviderKind;
  searxngUrl: string | null;
  braveApiKey: string | null;
  /** SearXNG principal avec Brave en secours (si une clé Brave est configurée). */
  fallback: boolean;
};

/** Configuration effective : valeurs de l'administration, sinon variables d'environnement. */
export function searchConfigFrom(
  s: Pick<AppSettings, "searchProvider" | "searxngUrl" | "braveApiKey"> & Partial<Pick<AppSettings, "searchFallbackEnabled">>,
): SearchConfig {
  const e = env();
  return {
    kind: s.searchProvider,
    searxngUrl: s.searxngUrl || e.SEARXNG_URL || DEFAULT_SEARXNG_URL,
    braveApiKey: s.braveApiKey || e.BRAVE_SEARCH_API_KEY || null,
    fallback: s.searchFallbackEnabled ?? true,
  };
}

/** Le secours Brave est-il réellement actif ? */
export function hasSearchFallback(config: SearchConfig): boolean {
  return config.kind === "SEARXNG" && config.fallback && Boolean(config.braveApiKey);
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
  const searxng = new SearxngProvider(check.url);
  return hasSearchFallback(config) ? new FallbackSearchProvider(searxng, new BraveProvider(config.braveApiKey!)) : searxng;
}

export function isSearchConfigured(config: SearchConfig): boolean {
  return config.kind === "BRAVE" ? Boolean(config.braveApiKey) : Boolean(config.searxngUrl);
}
