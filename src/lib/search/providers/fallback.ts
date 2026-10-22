import "server-only";
import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from "./types";

// Moteur principal (SearXNG) avec moteur de secours (Brave) : le secours est interrogé quand le principal
// échoue (injoignable, délai, erreur HTTP, limitation) ou ne renvoie aucun résultat — cas fréquent quand
// les moteurs amont de SearXNG bloquent temporairement l'instance.

export class FallbackSearchProvider implements SearchProvider {
  readonly kind: SearchProvider["kind"];
  readonly label: string;

  constructor(
    private readonly primary: SearchProvider,
    private readonly secondary: SearchProvider,
  ) {
    this.kind = primary.kind;
    this.label = `${primary.label} (secours : ${secondary.label})`;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    let reason: string;
    try {
      const results = await this.primary.search(query, opts);
      if (results.length > 0) return results;
      reason = "aucun résultat";
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof SearchError && err.code === "aborted")) throw err;
      reason = err instanceof SearchError ? err.message : "erreur inattendue";
    }
    try {
      const results = await this.secondary.search(query, opts);
      return results.map((r) => ({ ...r, via: this.secondary.kind, fallbackReason: `${this.primary.label} : ${reason}` }));
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof SearchError && err.code === "aborted")) throw err;
      const e = err instanceof SearchError ? err : new SearchError("Erreur inattendue du moteur de secours.", "bad_response");
      throw new SearchError(`${this.primary.label} : ${reason} ; ${this.secondary.label} (secours) : ${e.message}`, e.code, e.hint);
    }
  }
}
