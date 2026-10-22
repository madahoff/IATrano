import { computeVerdict, redactReport, skipped, type DiagnosticReport, type DiagnosticStep } from "@/lib/diagnostics/report";
import { tcpProbe as realTcpProbe, type TcpProbe } from "@/lib/diagnostics/tcp";
import { PROVIDER_LABELS } from "./registry";
import { ProviderError, type LlmProvider, type ModelInfo, type ProviderConfig } from "./types";

// Test de connexion au serveur LLM (Qwen) étape par étape, sur le même modèle que celui de JEV.

export type LlmDiagnosticInput = { config: ProviderConfig; preferredModel: string | null };
export type LlmDiagnosticDeps = { provider: LlmProvider; tcpProbe?: TcpProbe };

const elapsed = (start: number) => Math.round(performance.now() - start);

function hostPort(baseUrl: string): { host: string; port: number } | null {
  try {
    const u = new URL(baseUrl);
    return { host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)) };
  } catch {
    return null;
  }
}

export async function runLlmDiagnostics(input: LlmDiagnosticInput, deps: LlmDiagnosticDeps): Promise<DiagnosticReport> {
  const startedAt = new Date();
  const t0 = performance.now();
  const { config } = input;
  const steps: DiagnosticStep[] = [];
  const probe = deps.tcpProbe ?? realTcpProbe;
  const finish = (): DiagnosticReport =>
    redactReport(
      {
        target: "LLM",
        title: `Serveur LLM (${PROVIDER_LABELS[config.kind]})`,
        endpoint: config.baseUrl,
        keyInfo: config.apiKey ? "configurée (masquée)" : "aucune",
        startedAt: startedAt.toISOString(),
        totalMs: elapsed(t0),
        verdict: computeVerdict(steps),
        steps,
      },
      [config.apiKey],
    );
  const LABELS: Array<[string, string, boolean]> = [
    ["tcp", "Joignabilité réseau (TCP)", true],
    ["service", "Service LLM (version)", true],
    ["models", "Liste des modèles", true],
    ["completion", "Courte complétion sans thinking", true],
    ["thinking", "Courte complétion avec thinking", false],
    ["perf", "Latence", false],
  ];
  const rest = (from: number) => LABELS.slice(from).forEach(([id, label, essential]) => steps.push(skipped(id, label, essential)));

  // 1. TCP
  const hp = hostPort(config.baseUrl);
  if (!hp) {
    steps.push({ id: "tcp", label: LABELS[0][1], status: "fail", durationMs: 0, error: `Adresse invalide : ${config.baseUrl}`, hint: "Corrigez l'adresse dans Administration → Serveur IA.", essential: true });
    rest(1);
    return finish();
  }
  const tcp = await probe(hp.host, hp.port, 5000);
  if (!tcp.ok) {
    steps.push({
      id: "tcp",
      label: LABELS[0][1],
      status: "fail",
      durationMs: tcp.durationMs,
      error: `Impossible d'ouvrir ${hp.host}:${hp.port} (${tcp.code}).`,
      hint:
        tcp.code === "ECONNREFUSED"
          ? `La machine répond mais rien n'écoute sur ${hp.port} : vérifier \`systemctl status ollama\` et OLLAMA_HOST=0.0.0.0:${hp.port} sur le serveur.`
          : `Serveur injoignable : vérifier que Tailscale est connecté sur les deux machines et que le pare-feu autorise le port ${hp.port}.`,
      essential: true,
    });
    rest(1);
    return finish();
  }
  steps.push({ id: "tcp", label: LABELS[0][1], status: "ok", durationMs: tcp.durationMs, detail: `Port ${hp.port} ouvert sur ${tcp.address ?? hp.host}.`, essential: true });

  // 2. Service
  let s = performance.now();
  const conn = await deps.provider.testConnection();
  if (!conn.ok) {
    steps.push({ id: "service", label: LABELS[1][1], status: "fail", durationMs: elapsed(s), error: conn.error, hint: conn.hint, essential: true });
    rest(2);
    return finish();
  }
  steps.push({ id: "service", label: LABELS[1][1], status: "ok", durationMs: elapsed(s), detail: conn.version ? `Version ${conn.version}.` : "Le serveur répond.", essential: true });

  // 3. Modèles
  s = performance.now();
  let models: ModelInfo[];
  try {
    models = await deps.provider.listModels();
  } catch (err) {
    const e = err instanceof ProviderError ? err : null;
    steps.push({ id: "models", label: LABELS[2][1], status: "fail", durationMs: elapsed(s), error: e?.message ?? String(err), hint: e?.hint, essential: true });
    rest(3);
    return finish();
  }
  const model = models.find((m) => m.id === input.preferredModel) ?? models[0];
  if (!model) {
    steps.push({ id: "models", label: LABELS[2][1], status: "fail", durationMs: elapsed(s), error: "Aucun modèle n'est installé sur le serveur.", hint: "Installez le modèle sur le serveur (ex. ollama pull qwen3:32b).", essential: true });
    rest(3);
    return finish();
  }
  const warnings: string[] = [];
  if (input.preferredModel && model.id !== input.preferredModel) warnings.push(`Le modèle par défaut « ${input.preferredModel} » est absent ; test avec « ${model.id} ».`);
  if (model.capabilities.tools === "no") warnings.push(`« ${model.id} » ne déclare pas l'appel d'outils : Qwen ne pourra pas utiliser jev_decide avec ce modèle.`);
  steps.push({
    id: "models",
    label: LABELS[2][1],
    status: "ok",
    durationMs: elapsed(s),
    detail: `${models.length} modèle(s) : ${models.map((m) => m.id).join(", ")}. Modèle testé : ${model.id}${model.capabilities.tools === "yes" ? " (appel d'outils pris en charge)" : ""}.`,
    warnings: warnings.length ? warnings : undefined,
    essential: true,
  });

  // 4. Complétion courte sans raisonnement, puis 5. avec raisonnement (si le modèle le prend en charge).
  const thinkingCapable = model.capabilities.thinking === "yes";
  const run = async (think: boolean | undefined) => {
    const st = performance.now();
    const answer = await deps.provider.complete({
      model: model.id,
      messages: [{ role: "user", content: think ? "Is 17 a prime number? Answer with one word." : "Reply with exactly one word: OK" }],
      think,
      temperature: 0,
    });
    return { text: answer.trim(), ms: elapsed(st) };
  };
  let plainMs: number;
  try {
    const r = await run(thinkingCapable ? false : undefined);
    plainMs = r.ms;
    steps.push({
      id: "completion",
      label: LABELS[3][1],
      status: r.text ? "ok" : "fail",
      durationMs: r.ms,
      detail: r.text ? `Réponse : « ${r.text.slice(0, 80)} ».` : undefined,
      error: r.text ? undefined : "Le modèle a renvoyé une réponse vide.",
      hint: r.text ? undefined : "Vérifiez le modèle (ollama run <modèle>) et la mémoire disponible sur le serveur.",
      essential: true,
    });
  } catch (err) {
    const e = err instanceof ProviderError ? err : null;
    steps.push({ id: "completion", label: LABELS[3][1], status: "fail", durationMs: null, error: e?.message ?? String(err), hint: e?.hint, essential: true });
    rest(4);
    return finish();
  }

  let thinkingMs: number | null = null;
  if (!thinkingCapable) {
    steps.push({ ...skipped("thinking", LABELS[4][1], false, `« ${model.id} » ne déclare pas le mode thinking : test non applicable.`), notApplicable: true });
  } else {
    try {
      const r = await run(true);
      thinkingMs = r.ms;
      steps.push({ id: "thinking", label: LABELS[4][1], status: r.text ? "ok" : "fail", durationMs: r.ms, detail: r.text ? `Réponse finale (raisonnement séparé) : « ${r.text.slice(0, 80)} ».` : undefined, error: r.text ? undefined : "Réponse finale vide après le raisonnement.", hint: r.text ? undefined : "Augmentez le délai d'attente : le raisonnement peut être long.", essential: false });
    } catch (err) {
      const e = err instanceof ProviderError ? err : null;
      steps.push({ id: "thinking", label: LABELS[4][1], status: "fail", durationMs: null, error: e?.message ?? String(err), hint: e?.hint, essential: false });
    }
  }

  steps.push({
    id: "perf",
    label: LABELS[5][1],
    status: "ok",
    durationMs: plainMs,
    detail: [
      `Service ${steps[1].durationMs} ms`,
      `complétion sans thinking ${plainMs} ms (inclut le chargement du modèle s'il n'était pas en mémoire)`,
      thinkingMs !== null ? `avec thinking ${thinkingMs} ms` : null,
    ].filter(Boolean).join(" · ") + ".",
    essential: false,
  });
  return finish();
}
