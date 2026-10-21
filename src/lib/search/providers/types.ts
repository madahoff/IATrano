// Contrat commun des moteurs de recherche Web, indépendant du fournisseur de LLM.
// Ajouter un moteur = implémenter SearchProvider et l'enregistrer dans providers/index.ts.

export type SearchProviderKind = "SEARXNG" | "BRAVE";

export type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  /** Date fournie par le moteur, si elle existe (jamais déduite). */
  publishedAt: string | null;
  engine?: string;
};

export type SearchOptions = {
  signal?: AbortSignal;
  count: number;
  timeoutMs: number;
  /** Restreint aux résultats récents quand le moteur le permet. */
  freshness?: "day" | "week" | "month" | "year";
  language?: string;
};

export type SearchErrorCode = "not_configured" | "unreachable" | "timeout" | "http_error" | "bad_response" | "aborted" | "rate_limited" | "unauthorized";

export class SearchError extends Error {
  constructor(
    message: string,
    public readonly code: SearchErrorCode,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

export interface SearchProvider {
  readonly kind: SearchProviderKind;
  readonly label: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
