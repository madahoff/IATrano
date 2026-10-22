import { computeVerdict, redactReport, skipped, type DiagnosticReport, type DiagnosticStep } from "@/lib/diagnostics/report";
import { tcpProbe as realTcpProbe, type TcpProbe } from "@/lib/diagnostics/tcp";
import { SearchError, type SearchProvider, type SearchProviderKind } from "./providers/types";

// Test du service de recherche Web étape par étape (même présentation que JEV et le LLM).

export type SearchDiagnosticInput = {
  kind: SearchProviderKind;
  label: string;
  /** URL interrogée (SearXNG) ou API publique (Brave). */
  endpoint: string;
  apiKey: string | null;
  timeoutMs: number;
  maxResults: number;
};
export type SearchDiagnosticDeps = {
  /** Moteur principal testé seul (sans secours, pour ne pas masquer une panne). */
  provider: SearchProvider | SearchError;
  /** Moteur de secours (Brave) s'il est actif, null sinon. */
  backup?: SearchProvider | null;
  tcpProbe?: TcpProbe;
};

const QUERY = "actualités intelligence artificielle";
const elapsed = (start: number) => Math.round(performance.now() - start);

export async function runSearchDiagnostics(input: SearchDiagnosticInput, deps: SearchDiagnosticDeps): Promise<DiagnosticReport> {
  const startedAt = new Date();
  const t0 = performance.now();
  const steps: DiagnosticStep[] = [];
  const probe = deps.tcpProbe ?? realTcpProbe;
  const finish = (): DiagnosticReport =>
    redactReport(
      {
        target: "SEARCH",
        title: `Recherche Web (${input.label})`,
        endpoint: input.endpoint,
        keyInfo: input.kind === "BRAVE" ? (input.apiKey ? "configurée (masquée)" : "aucune") : undefined,
        startedAt: startedAt.toISOString(),
        totalMs: elapsed(t0),
        verdict: computeVerdict(steps),
        steps,
      },
      [input.apiKey],
    );
  const LABELS: Array<[string, string, boolean]> = [
    ["config", "Configuration", true],
    ["tcp", "Joignabilité réseau (TCP)", true],
    ["query", `Requête de test (« ${QUERY} »)`, true],
    ["backup", "Moteur de secours (Brave Search)", false],
    ["perf", "Latence", false],
  ];
  const rest = (from: number) => LABELS.slice(from).forEach(([id, label, essential]) => steps.push(skipped(id, label, essential)));

  // 1. Configuration
  if (deps.provider instanceof SearchError) {
    steps.push({ id: "config", label: LABELS[0][1], status: "fail", durationMs: 0, error: deps.provider.message, hint: deps.provider.hint, essential: true });
    rest(1);
    return finish();
  }
  const provider = deps.provider;
  steps.push({ id: "config", label: LABELS[0][1], status: "ok", durationMs: 0, detail: `${input.label} · ${input.endpoint}`, essential: true });

  // 2. TCP
  let host = "";
  let port = 0;
  try {
    const u = new URL(input.endpoint);
    host = u.hostname;
    port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {}
  const tcp = await probe(host, port, 5000);
  if (!tcp.ok) {
    steps.push({
      id: "tcp",
      label: LABELS[1][1],
      status: "fail",
      durationMs: tcp.durationMs,
      error: `Impossible d'ouvrir ${host}:${port} (${tcp.code}).`,
      hint:
        input.kind === "SEARXNG"
          ? tcp.code === "ECONNREFUSED"
            ? "SearXNG ne tourne pas sur ce port : vérifiez le conteneur (docker ps) et l'adresse dans Administration → Recherche Web."
            : "Service injoignable : vérifiez l'adresse, Tailscale et le pare-feu."
          : "L'API Brave est injoignable : vérifiez l'accès Internet du serveur IATrano.",
      essential: true,
    });
    rest(2);
    return finish();
  }
  steps.push({ id: "tcp", label: LABELS[1][1], status: "ok", durationMs: tcp.durationMs, detail: `Port ${port} ouvert sur ${tcp.address ?? host}.`, essential: true });

  // 3. Requête sur le moteur principal
  let s = performance.now();
  let primaryMs: number | null = null;
  try {
    const results = await provider.search(QUERY, { count: input.maxResults, timeoutMs: input.timeoutMs });
    primaryMs = elapsed(s);
    steps.push({
      id: "query",
      label: LABELS[2][1],
      status: results.length ? "ok" : "fail",
      durationMs: primaryMs,
      detail: results.length ? `${results.length} résultat(s), dont « ${results[0].title.slice(0, 80)} ».` : undefined,
      error: results.length ? undefined : "Aucun résultat renvoyé.",
      hint: results.length ? undefined : "Les moteurs amont de SearXNG sont peut-être bloqués (captcha, limite de débit) : consultez les journaux du conteneur.",
      // Avec un secours actif, la recherche reste possible même si le principal ne répond pas.
      essential: !deps.backup,
    });
  } catch (err) {
    const e = err instanceof SearchError ? err : new SearchError(String(err), "bad_response");
    steps.push({ id: "query", label: LABELS[2][1], status: "fail", durationMs: elapsed(s), error: e.message, hint: e.hint, essential: !deps.backup });
  }

  // 4. Secours
  if (!deps.backup) {
    steps.push({
      ...skipped("backup", LABELS[3][1], false, input.kind === "SEARXNG" ? "Aucun secours : renseignez une clé Brave Search et activez le basculement (Administration → Recherche Web)." : "Sans objet : Brave est déjà le moteur principal."),
      notApplicable: true,
    });
  } else {
    s = performance.now();
    try {
      const results = await deps.backup.search(QUERY, { count: input.maxResults, timeoutMs: input.timeoutMs });
      steps.push({ id: "backup", label: LABELS[3][1], status: results.length ? "ok" : "fail", durationMs: elapsed(s), detail: `${results.length} résultat(s) : prêt à prendre le relais si SearXNG échoue.`, error: results.length ? undefined : "Aucun résultat renvoyé par Brave.", essential: false });
    } catch (err) {
      const e = err instanceof SearchError ? err : new SearchError(String(err), "bad_response");
      steps.push({ id: "backup", label: LABELS[3][1], status: "fail", durationMs: elapsed(s), error: e.message, hint: e.hint, essential: false });
    }
  }
  const query = steps.find((x) => x.id === "query")!;
  const backup = steps.find((x) => x.id === "backup")!;
  if (query.status !== "ok" && backup.status !== "ok") query.essential = true;

  steps.push(
    primaryMs === null
      ? skipped("perf", LABELS[4][1], false, "Moteur principal en échec : latence non mesurée.")
      : { id: "perf", label: LABELS[4][1], status: "ok", durationMs: primaryMs, detail: `Recherche en ${primaryMs} ms.`, essential: false },
  );
  return finish();
}
