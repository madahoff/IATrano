import "server-only";
import { createJevClient, JevError, type JevDecision, type JevQuestion } from "./client";
import { jevBaseUrl } from "./config";
import { clientConfigFrom, getCachedJevSettings } from "./settings";

// Accès à JEV pour le reste de l'application : ne lève jamais d'exception, une panne de JEV
// ne doit jamais bloquer la conversation (l'appelant applique son repli).

export type SafeDecision = { ok: true; decision: JevDecision } | { ok: false; code: JevError["code"] | "internal"; error: string; hint?: string };

export async function safeJevDecide(state: string | Record<string, unknown>, questions: JevQuestion[], signal?: AbortSignal): Promise<SafeDecision> {
  try {
    const client = createJevClient(clientConfigFrom(await getCachedJevSettings()));
    return { ok: true, decision: await client.decide(state, questions, { signal }) };
  } catch (err) {
    if (err instanceof JevError) return { ok: false, code: err.code, error: err.message, hint: err.hint };
    return { ok: false, code: "internal", error: err instanceof Error ? err.message : String(err) };
  }
}

export type JevHealthState = "green" | "orange" | "red";
export type JevHealthStatus = { state: JevHealthState; label: string; detail?: string; latencyMs: number | null; endpoint: string; checkedAt: string };

/**
 * État pour la pastille : vert = prêt, orange = répond mais pas prêt (chargement, réponse inattendue),
 * rouge = injoignable. Délai court (3 s max) : appelé toutes les 30 s par chaque page ouverte.
 */
export async function checkJevHealth(): Promise<JevHealthStatus> {
  const checkedAt = new Date().toISOString();
  let endpoint = "";
  try {
    const settings = await getCachedJevSettings();
    endpoint = jevBaseUrl(settings);
    const client = createJevClient({ ...clientConfigFrom(settings), timeoutMs: Math.min(settings.timeoutMs, 3000) });
    const h = await client.health();
    return h.ready
      ? { state: "green", label: "JEV opérationnel", latencyMs: h.timing.totalMs, endpoint, checkedAt }
      : { state: "orange", label: "JEV démarré, modèle pas encore prêt", detail: `Statut : ${h.status}`, latencyMs: h.timing.totalMs, endpoint, checkedAt };
  } catch (err) {
    if (err instanceof JevError && (err.code === "bad_response" || err.code === "http_error")) {
      return { state: "orange", label: "JEV répond de façon inattendue", detail: err.message, latencyMs: null, endpoint, checkedAt };
    }
    return { state: "red", label: "JEV injoignable", detail: err instanceof Error ? err.message : String(err), latencyMs: null, endpoint, checkedAt };
  }
}
