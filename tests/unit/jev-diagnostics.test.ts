// Test de connexion étape par étape contre un faux serveur JEV réel (TCP + HTTP), et diagnostics LLM / recherche.
import { afterEach, describe, expect, it } from "vitest";
import { runJevDiagnostics, JEV_TEST_SAMPLE, type JevDiagnosticInput } from "@/lib/jev/diagnostics";
import { runLlmDiagnostics } from "@/lib/llm/diagnostics";
import { runSearchDiagnostics } from "@/lib/search/diagnostics";
import { computeVerdict, formatReportText, redactReport, type DiagnosticReport } from "@/lib/diagnostics/report";
import { ProviderError, type LlmProvider, type ModelInfo } from "@/lib/llm/types";
import { SearchError, type SearchProvider } from "@/lib/search/providers/types";
import type { TcpProbe } from "@/lib/diagnostics/tcp";
import { closedPort, startFakeJev, type FakeJev, type FakeJevOptions } from "../support/fake-jev";

const KEY = "cle-secrete-de-test-1234";
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function diagnose(opts: FakeJevOptions, input: Partial<JevDiagnosticInput> = {}) {
  fake = await startFakeJev(opts);
  return runJevDiagnostics({ host: "127.0.0.1", port: fake.port, protocol: "HTTP", apiKey: KEY, timeoutMs: 2000, keyInfo: "configurée (masquée)", ...input });
}

const step = (r: DiagnosticReport, id: string) => r.steps.find((s) => s.id === id)!;
const statuses = (r: DiagnosticReport) => Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

// Probabilités de routage plausibles selon le message d'exemple.
const routingNoul = (name: string, state: string) => {
  if (state === JEV_TEST_SAMPLE.state) return 0.93;
  if (name === "thinking") return state.includes("raisonnement") ? 0.88 : 0.1;
  if (name === "research") return state.includes("cette semaine") ? 0.81 : 0.05;
  return 0.2;
};

describe("runJevDiagnostics", () => {
  it("succès : 7 étapes réussies et connexion opérationnelle", async () => {
    const r = await diagnose({ apiKey: KEY, noul: routingNoul });
    expect(statuses(r)).toEqual({ tcp: "ok", health: "ok", models: "ok", auth: "ok", decision: "ok", routing: "ok", perf: "ok" });
    expect(r.verdict).toBe("OK");
    expect(step(r, "decision").detail).toContain("0.930");
    expect(step(r, "auth").detail).toMatch(/sans clé correctement refusée/);
    expect(step(r, "routing").detail).toMatch(/Problème de logique → Réflexion approfondie/);
    expect(step(r, "routing").detail).toMatch(/Question d'actualité → Recherche web/);
    expect(step(r, "routing").warnings).toBeUndefined();
    expect(step(r, "perf").detail).toMatch(/inférence 42.5 ms/);
    // Une seule requête par message de routage, avec les trois questions.
    const routingCalls = fake!.requests.filter((q) => q.path === "/v1/systemone" && (q.body as { state: string }).state !== JEV_TEST_SAMPLE.state);
    expect(routingCalls).toHaveLength(3);
    expect(Object.keys((routingCalls[0].body as { questions: object }).questions)).toEqual(["thinking", "research", "interactive"]);
  });

  it("port fermé : échec TCP, étapes suivantes non exécutées", async () => {
    const port = await closedPort();
    const r = await runJevDiagnostics({ host: "127.0.0.1", port, protocol: "HTTP", apiKey: KEY, timeoutMs: 1000, keyInfo: "" });
    expect(step(r, "tcp").status).toBe("fail");
    expect(step(r, "tcp").error).toMatch(/Connexion refusée/);
    expect(r.steps.slice(1).every((s) => s.status === "skip" && s.durationMs === null)).toBe(true);
    expect(r.verdict).toBe("FAILED");
  });

  it("hôte injoignable (sonde TCP en délai dépassé) : message Tailscale / pare-feu", async () => {
    const probe: TcpProbe = async () => ({ ok: false, durationMs: 5000, code: "ETIMEDOUT", message: "aucune réponse" });
    const r = await runJevDiagnostics({ host: "100.121.17.90", port: 8017, protocol: "HTTP", apiKey: null, timeoutMs: 1000, keyInfo: "" }, { tcpProbe: probe });
    expect(step(r, "tcp").hint).toBe("Serveur injoignable : vérifier que Tailscale est connecté sur les deux machines (tailscale status) et que le pare-feu autorise le port 8017.");
  });

  it("timeout : /health ne répond pas dans le délai", async () => {
    const r = await diagnose({ apiKey: KEY, healthDelayMs: 800 }, { timeoutMs: 200 });
    expect(step(r, "tcp").status).toBe("ok");
    expect(step(r, "health").status).toBe("fail");
    expect(step(r, "health").error).toMatch(/n'a pas répondu dans le délai/);
    expect(step(r, "health").hint).toMatch(/systemctl status jev/);
    expect(step(r, "decision").status).toBe("skip");
    expect(r.verdict).toBe("FAILED");
  });

  it("timeout pendant la décision", async () => {
    const r = await diagnose({ apiKey: KEY, decideDelayMs: 800 }, { timeoutMs: 300 });
    expect(step(r, "decision").status).toBe("fail");
    expect(step(r, "decision").error).toMatch(/délai/);
    expect(step(r, "routing").status).toBe("skip");
    expect(r.verdict).toBe("FAILED");
  });

  it("/health non prêt : statut affiché et piste systemctl", async () => {
    const r = await diagnose({ apiKey: KEY, healthStatus: "loading" });
    expect(step(r, "health").status).toBe("fail");
    expect(step(r, "health").error).toMatch(/« loading »/);
    expect(step(r, "health").hint).toBe("Service JEV arrêté ou modèle en cours de chargement : vérifier `systemctl status jev` sur le serveur.");
    expect(step(r, "models").status).toBe("skip");
    expect(r.verdict).toBe("FAILED");
  });

  it("401 : clé refusée, décision non exécutée", async () => {
    const r = await diagnose({ apiKey: "autre-cle" });
    expect(step(r, "models").status).toBe("fail");
    expect(step(r, "auth").status).toBe("fail");
    expect(step(r, "auth").hint).toMatch(/^Clé API refusée : vérifier JEV_API_KEY sur le serveur/);
    expect(step(r, "decision").status).toBe("skip");
    expect(r.verdict).toBe("FAILED");
  });

  it("aucune clé configurée alors que le serveur en exige une", async () => {
    const r = await diagnose({ apiKey: KEY }, { apiKey: null });
    expect(step(r, "auth").status).toBe("fail");
    expect(step(r, "auth").error).toMatch(/exige une clé/);
    expect(r.verdict).toBe("FAILED");
  });

  it("serveur sans authentification : avertissement, connexion utilisable", async () => {
    const r = await diagnose({ apiKey: null, noul: routingNoul });
    expect(step(r, "auth").status).toBe("ok");
    expect(step(r, "auth").warnings?.[0]).toMatch(/accepte les requêtes SANS clé/);
    expect(r.verdict).toBe("OK");
  });

  it("réponse mal formée sur /v1/systemone", async () => {
    const r = await diagnose({ apiKey: KEY, malformedDecision: true });
    expect(step(r, "decision").status).toBe("fail");
    expect(step(r, "decision").error).toMatch(/Réponse mal formée sur \/v1\/systemone/);
    expect(r.verdict).toBe("FAILED");
  });

  it("réponse mal formée sur /health (pas un serveur JEV)", async () => {
    fake = await startFakeJev();
    // Un serveur HTTP quelconque : /health renvoie un JSON sans « status ».
    const r = await runJevDiagnostics(
      { host: "127.0.0.1", port: fake.port, protocol: "HTTP", apiKey: null, timeoutMs: 1000, keyInfo: "" },
      { fetch: (async () => Response.json({ ok: true })) as typeof fetch },
    );
    expect(step(r, "health").status).toBe("fail");
    expect(step(r, "health").error).toMatch(/mal formée/);
  });

  it("probabilité trop basse : connexion partielle", async () => {
    const r = await diagnose({ apiKey: KEY, noul: () => 0.2 });
    expect(step(r, "decision").status).toBe("fail");
    expect(step(r, "decision").error).toMatch(/trop basse/);
    expect(step(r, "perf").status).toBe("ok");
    expect(r.verdict).toBe("PARTIAL");
  });

  it("alias jev-latest absent : connexion partielle", async () => {
    const r = await diagnose({ apiKey: KEY, models: ["jevos-1b"], noul: routingNoul });
    expect(step(r, "models").status).toBe("fail");
    expect(step(r, "models").error).toMatch(/jev-latest/);
    expect(r.verdict).toBe("PARTIAL");
  });

  it("routage inattendu : avertissement par message", async () => {
    const r = await diagnose({ apiKey: KEY, noul: (_n, s) => (s === JEV_TEST_SAMPLE.state ? 0.9 : 0.1) });
    expect(step(r, "routing").status).toBe("ok");
    expect(step(r, "routing").warnings).toHaveLength(2);
  });

  it("Server-Timing absent : latence totale seule", async () => {
    const r = await diagnose({ apiKey: KEY, serverTiming: null, noul: routingNoul });
    expect(step(r, "perf").detail).toMatch(/Server-Timing absent/);
  });

  it("la clé n'apparaît jamais dans le rapport", async () => {
    const r = await diagnose({ apiKey: "autre-cle" });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(formatReportText(r)).not.toContain(KEY);
  });
});

describe("rapport", () => {
  it("verdict : essentiel en échec → FAILED ; autre échec → PARTIAL ; sans objet ignoré", () => {
    const ok = { id: "a", label: "a", status: "ok" as const, durationMs: 1, essential: true };
    expect(computeVerdict([ok])).toBe("OK");
    expect(computeVerdict([ok, { ...ok, id: "b", status: "fail", essential: false }])).toBe("PARTIAL");
    expect(computeVerdict([ok, { ...ok, id: "b", status: "skip", essential: false, notApplicable: true }])).toBe("OK");
    expect(computeVerdict([{ ...ok, status: "fail" }])).toBe("FAILED");
  });

  it("texte brut avec icônes, durées, causes et clé masquée", () => {
    const report: DiagnosticReport = {
      target: "JEV",
      title: "JEV",
      endpoint: "http://100.121.17.90:8017",
      keyInfo: "configurée (masquée)",
      startedAt: new Date().toISOString(),
      totalMs: 12,
      verdict: "FAILED",
      steps: [
        { id: "tcp", label: "Joignabilité réseau (TCP)", status: "ok", durationMs: 3, essential: true },
        { id: "auth", label: "Authentification", status: "fail", durationMs: 4, error: "Clé abc-secret refusée", hint: "Vérifier", essential: true },
        { id: "decision", label: "Décision", status: "skip", durationMs: null, essential: true },
      ],
    };
    const text = formatReportText(redactReport(report, ["abc-secret"]));
    expect(text).toContain("Verdict : Échec");
    expect(text).toContain("[OK] 1. Joignabilité réseau (TCP) — 3 ms");
    expect(text).toContain("[ÉCHEC] 2. Authentification — 4 ms");
    expect(text).toContain("Cause : Clé •••• refusée");
    expect(text).toContain("[IGNORÉE] 3. Décision — non exécutée");
    expect(text).not.toContain("abc-secret");
  });
});

// --- LLM ----------------------------------------------------------------------

const openProbe: TcpProbe = async () => ({ ok: true, durationMs: 1, address: "100.121.17.90" });

function fakeLlm(over: Partial<LlmProvider> & { models?: ModelInfo[] } = {}): LlmProvider & { calls: Array<boolean | undefined> } {
  const calls: Array<boolean | undefined> = [];
  const models: ModelInfo[] = over.models ?? [
    { id: "qwen3:32b", name: "qwen3:32b", provider: "OLLAMA", capabilities: { thinking: "yes", tools: "yes", vision: "no" } },
  ];
  return {
    kind: "OLLAMA",
    label: "Ollama",
    calls,
    testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://100.121.17.90:11434", version: "0.30.7", latencyMs: 3 }),
    listModels: async () => models,
    complete: async (req) => {
      calls.push(req.think);
      return req.think ? "Yes" : "OK";
    },
    completeJson: async () => "{}",
    chatStream: async function* () {},
    ...over,
  };
}

const llmInput = { config: { kind: "OLLAMA" as const, baseUrl: "http://100.121.17.90:11434", apiKey: null, timeoutMs: 1000 }, preferredModel: "qwen3:32b" };

describe("runLlmDiagnostics", () => {
  it("complétion sans puis avec thinking pour un modèle qui le prend en charge", async () => {
    const provider = fakeLlm();
    const r = await runLlmDiagnostics(llmInput, { provider, tcpProbe: openProbe });
    expect(r.verdict).toBe("OK");
    expect(provider.calls).toEqual([false, true]);
    expect(r.steps.map((s) => s.id)).toEqual(["tcp", "service", "models", "completion", "thinking", "perf"]);
  });

  it("modèle sans thinking : étape sans objet, verdict non dégradé", async () => {
    const provider = fakeLlm({ models: [{ id: "qwen2.5:3b", name: "qwen2.5:3b", provider: "OLLAMA", capabilities: { thinking: "no", tools: "yes", vision: "no" } }] });
    const r = await runLlmDiagnostics({ ...llmInput, preferredModel: null }, { provider, tcpProbe: openProbe });
    expect(step(r, "thinking").status).toBe("skip");
    expect(r.verdict).toBe("OK");
    expect(provider.calls).toEqual([undefined]);
  });

  it("port fermé : message Ollama / OLLAMA_HOST", async () => {
    const r = await runLlmDiagnostics(llmInput, { provider: fakeLlm(), tcpProbe: async () => ({ ok: false, durationMs: 1, code: "ECONNREFUSED", message: "refused" }) });
    expect(step(r, "tcp").hint).toMatch(/OLLAMA_HOST/);
    expect(r.verdict).toBe("FAILED");
  });

  it("complétion en erreur : échec avec la cause du fournisseur", async () => {
    const provider = fakeLlm({ complete: async () => { throw new ProviderError("Le serveur IA n'a pas répondu.", "timeout", "Augmentez le délai."); } });
    const r = await runLlmDiagnostics(llmInput, { provider, tcpProbe: openProbe });
    expect(step(r, "completion")).toMatchObject({ status: "fail", hint: "Augmentez le délai." });
    expect(step(r, "thinking").status).toBe("skip");
    expect(r.verdict).toBe("FAILED");
  });

  it("modèle par défaut absent et appel d'outils non déclaré : avertissements", async () => {
    const provider = fakeLlm({ models: [{ id: "llama3:8b", name: "llama3:8b", provider: "OLLAMA", capabilities: { thinking: "no", tools: "no", vision: "no" } }] });
    const r = await runLlmDiagnostics(llmInput, { provider, tcpProbe: openProbe });
    expect(step(r, "models").warnings).toHaveLength(2);
  });
});

// --- Recherche ------------------------------------------------------------------

describe("runSearchDiagnostics", () => {
  const input = { kind: "SEARXNG" as const, label: "SearXNG", endpoint: "http://100.121.17.90:8888", apiKey: null, timeoutMs: 1000, maxResults: 5 };
  const provider = (results: number): SearchProvider => ({
    kind: "SEARXNG",
    label: "SearXNG",
    search: async () => Array.from({ length: results }, (_, i) => ({ url: `https://ex.com/${i}`, title: `Résultat ${i}`, snippet: "", publishedAt: null })),
  });

  it("succès sans secours : étape secours sans objet, verdict non dégradé", async () => {
    const r = await runSearchDiagnostics(input, { provider: provider(3), tcpProbe: openProbe });
    expect(r.verdict).toBe("OK");
    expect(step(r, "query").detail).toMatch(/3 résultat/);
    expect(step(r, "backup")).toMatchObject({ status: "skip", notApplicable: true });
    expect(step(r, "backup").detail).toMatch(/clé Brave/);
  });

  it("SearXNG en panne mais secours Brave opérationnel : connexion partielle", async () => {
    const down: SearchProvider = { kind: "SEARXNG", label: "SearXNG", search: async () => { throw new SearchError("SearXNG refuse la connexion.", "unreachable"); } };
    const brave: SearchProvider = { ...provider(4), kind: "BRAVE", label: "Brave Search" };
    const r = await runSearchDiagnostics(input, { provider: down, backup: brave, tcpProbe: openProbe });
    expect(step(r, "query").status).toBe("fail");
    expect(step(r, "backup")).toMatchObject({ status: "ok" });
    expect(r.verdict).toBe("PARTIAL");
  });

  it("SearXNG et secours en panne : échec", async () => {
    const down: SearchProvider = { kind: "SEARXNG", label: "SearXNG", search: async () => [] };
    const brave: SearchProvider = { kind: "BRAVE", label: "Brave Search", search: async () => { throw new SearchError("Clé Brave Search refusée.", "unauthorized"); } };
    const r = await runSearchDiagnostics(input, { provider: down, backup: brave, tcpProbe: openProbe });
    expect(step(r, "backup").error).toMatch(/refusée/);
    expect(r.verdict).toBe("FAILED");
  });

  it("non configuré", async () => {
    const r = await runSearchDiagnostics(input, { provider: new SearchError("Aucune clé Brave Search n'est configurée.", "not_configured") });
    expect(step(r, "config").status).toBe("fail");
    expect(r.verdict).toBe("FAILED");
  });

  it("aucun résultat", async () => {
    const r = await runSearchDiagnostics(input, { provider: provider(0), tcpProbe: openProbe });
    expect(step(r, "query").status).toBe("fail");
  });
});
