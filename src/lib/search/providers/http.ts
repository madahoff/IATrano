import "server-only";
import { SearchError } from "./types";

/** Appel HTTP vers un moteur de recherche configuré par l'administration (délai, annulation, erreurs lisibles). */
export async function searchFetch(url: string, init: RequestInit, opts: { signal?: AbortSignal; timeoutMs: number; label: string }): Promise<Response> {
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]) : AbortSignal.timeout(opts.timeoutMs);
  try {
    return await fetch(url, { ...init, signal, redirect: "error", cache: "no-store" });
  } catch (err) {
    if (opts.signal?.aborted) throw new SearchError("Recherche annulée.", "aborted");
    const e = err as { name?: string; cause?: { code?: string } };
    if (e?.name === "TimeoutError" || signal.aborted) {
      throw new SearchError(`${opts.label} n'a pas répondu dans le délai de ${Math.round(opts.timeoutMs / 1000)} s.`, "timeout");
    }
    const code = e?.cause?.code ?? "";
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    if (code === "ECONNREFUSED") {
      throw new SearchError(`${opts.label} refuse la connexion (${host}).`, "unreachable", "Vérifiez que le service est démarré et que l'adresse/port sont corrects.");
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new SearchError(`Hôte du moteur de recherche introuvable (${host}).`, "unreachable", "En Docker, utilisez le nom du service (ex. http://searxng:8080) ; hors Docker, http://localhost:<port>.");
    }
    throw new SearchError(`${opts.label} est injoignable (${code || e?.name || "erreur réseau"}).`, "unreachable");
  }
}
