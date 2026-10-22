import { computeVerdict, redactReport, skipped, type DiagnosticReport, type DiagnosticStep } from "@/lib/diagnostics/report";
import { tcpProbe as realTcpProbe, type TcpProbe } from "@/lib/diagnostics/tcp";
import { createJevClient, JEV_DEFAULT_MODEL, JevError, type JevDecision } from "./client";
import { jevBaseUrl, type JevProtocol } from "./config";
import { DEFAULT_MODES, MODE_EMOJI, MODE_LABELS, ROUTING_MODES, ROUTING_SAMPLES, type ModesConfig } from "@/lib/routing/config";

// Test de connexion à JEV en 7 étapes. Chaque étape est indépendante et ne lève jamais d'exception :
// un échec produit un message en français (cause probable + piste de correction).

export type JevDiagnosticInput = {
  host: string;
  port: number;
  protocol: JevProtocol;
  apiKey: string | null;
  timeoutMs: number;
  /** Description masquée de la clé, reprise dans le rapport. */
  keyInfo: string;
  /** Questions et seuils de routage (valeurs par défaut si absents). */
  routingModes?: ModesConfig;
};

export type JevDiagnosticDeps = { fetch?: typeof fetch; tcpProbe?: TcpProbe };

/** Exemple fixe dont la réponse attendue est clairement « oui ». */
export const JEV_TEST_SAMPLE = {
  state: "I was charged twice for the same order.",
  question: { name: "billing", instructions: "Is this a billing problem?" },
};

const UNREACHABLE_HINT = (port: number) =>
  `Serveur injoignable : vérifier que Tailscale est connecté sur les deux machines (tailscale status) et que le pare-feu autorise le port ${port}.`;
const HEALTH_HINT = "Service JEV arrêté ou modèle en cours de chargement : vérifier `systemctl status jev` sur le serveur.";

const elapsed = (start: number) => Math.round(performance.now() - start);

function failure(err: unknown): { error: string; hint?: string } {
  if (err instanceof JevError) return { error: err.message, hint: err.hint };
  return { error: err instanceof Error ? err.message : String(err) };
}

export async function runJevDiagnostics(input: JevDiagnosticInput, deps: JevDiagnosticDeps = {}): Promise<DiagnosticReport> {
  const startedAt = new Date();
  const t0 = performance.now();
  const baseUrl = jevBaseUrl(input);
  const steps: DiagnosticStep[] = [];
  const client = createJevClient({ baseUrl, apiKey: input.apiKey, timeoutMs: input.timeoutMs }, { fetch: deps.fetch });
  const probe = deps.tcpProbe ?? realTcpProbe;

  const finish = (): DiagnosticReport =>
    redactReport(
      {
        target: "JEV",
        title: "JEV",
        endpoint: baseUrl,
        keyInfo: input.keyInfo,
        startedAt: startedAt.toISOString(),
        totalMs: elapsed(t0),
        verdict: computeVerdict(steps),
        steps,
      },
      [input.apiKey],
    );

  const rest = (from: number) => {
    const all: Array<[string, string, boolean]> = [
      ["tcp", "Joignabilité réseau (TCP)", true],
      ["health", "Service démarré et modèle chargé (GET /health)", true],
      ["models", "Modèles servis (GET /v1/models)", false],
      ["auth", "Authentification par clé API", false],
      ["decision", "Décision de test (POST /v1/systemone)", true],
      ["routing", "Test de routage (3 messages d'exemple)", false],
      ["perf", "Performance", false],
    ];
    for (const [id, label, essential] of all.slice(from)) steps.push(skipped(id, label, essential));
  };

  // 1. Ouverture TCP sur hôte:port.
  const tcp = await probe(input.host, input.port, Math.min(input.timeoutMs, 5000));
  if (!tcp.ok) {
    const refused = tcp.code === "ECONNREFUSED";
    const unknownHost = tcp.code === "ENOTFOUND" || tcp.code === "EAI_AGAIN";
    steps.push({
      id: "tcp",
      label: "Joignabilité réseau (TCP)",
      status: "fail",
      durationMs: tcp.durationMs,
      error: unknownHost
        ? `Hôte « ${input.host} » introuvable (${tcp.code}).`
        : refused
          ? `Connexion refusée sur ${input.host}:${input.port} : la machine répond mais rien n'écoute sur ce port.`
          : `Impossible d'ouvrir ${input.host}:${input.port} (${tcp.code} : ${tcp.message}).`,
      hint: unknownHost
        ? "Utilisez l'adresse IP Tailscale du serveur (tailscale ip -4) ou vérifiez MagicDNS."
        : refused
          ? `Vérifier \`systemctl status jev\` et que le service écoute bien sur ${input.host}:${input.port} (option --host/--port).`
          : UNREACHABLE_HINT(input.port),
      essential: true,
    });
    rest(1);
    return finish();
  }
  steps.push({ id: "tcp", label: "Joignabilité réseau (TCP)", status: "ok", durationMs: tcp.durationMs, detail: `Port ${input.port} ouvert sur ${tcp.address ?? input.host}.`, essential: true });

  // 2. GET /health : service démarré et modèle chargé.
  let s = performance.now();
  try {
    const h = await client.health();
    if (!h.ready) {
      steps.push({ id: "health", label: "Service démarré et modèle chargé (GET /health)", status: "fail", durationMs: elapsed(s), error: `Le service répond mais son statut est « ${h.status} » (attendu : ready).`, hint: HEALTH_HINT, essential: true });
      rest(2);
      return finish();
    }
    const extra = Object.entries(h.raw)
      .filter(([k, v]) => k !== "status" && (typeof v === "string" || typeof v === "number") && String(v).length < 80)
      .slice(0, 3)
      .map(([k, v]) => `${k} : ${v}`);
    steps.push({ id: "health", label: "Service démarré et modèle chargé (GET /health)", status: "ok", durationMs: elapsed(s), detail: ["Statut : ready", ...extra].join(" · "), essential: true });
  } catch (err) {
    const f = failure(err);
    steps.push({ id: "health", label: "Service démarré et modèle chargé (GET /health)", status: "fail", durationMs: elapsed(s), error: f.error, hint: err instanceof JevError && err.code === "bad_response" ? f.hint : HEALTH_HINT, essential: true });
    rest(2);
    return finish();
  }

  // 3. GET /v1/models : modèle servi et alias jev-latest.
  s = performance.now();
  let modelsAuthRejected = false;
  try {
    const m = await client.models();
    const hasAlias = m.ids.includes(JEV_DEFAULT_MODEL);
    steps.push({
      id: "models",
      label: "Modèles servis (GET /v1/models)",
      status: hasAlias ? "ok" : "fail",
      durationMs: elapsed(s),
      detail: `Modèles : ${m.ids.join(", ") || "aucun"}.`,
      error: hasAlias ? undefined : `L'alias « ${JEV_DEFAULT_MODEL} » n'est pas exposé.`,
      hint: hasAlias ? undefined : "Mettez jevos à jour, ou indiquez à IATrano le nom exact du modèle servi.",
      essential: false,
    });
  } catch (err) {
    modelsAuthRejected = err instanceof JevError && err.code === "unauthorized";
    const f = failure(err);
    steps.push({ id: "models", label: "Modèles servis (GET /v1/models)", status: "fail", durationMs: elapsed(s), error: f.error, hint: modelsAuthRejected ? "Voir l'étape « Authentification » ci-dessous." : f.hint, essential: false });
  }

  // 4. Authentification : la clé configurée est acceptée, et une requête sans clé est refusée.
  s = performance.now();
  const auth: DiagnosticStep = { id: "auth", label: "Authentification par clé API", status: "ok", durationMs: null, essential: false, warnings: [] };
  let authBlocks = false;
  if (input.apiKey) {
    if (modelsAuthRejected) {
      auth.status = "fail";
      auth.error = "Clé API refusée (401).";
      auth.hint = "Clé API refusée : vérifier JEV_API_KEY sur le serveur (/etc/jev/jev.env) et la clé saisie ici, puis `systemctl restart jev`.";
      authBlocks = true;
    } else {
      auth.detail = "Clé configurée acceptée.";
    }
  }
  try {
    await client.models({ auth: false });
    auth.warnings!.push(
      input.apiKey
        ? "Le serveur accepte les requêtes SANS clé : JEV_API_KEY n'est probablement pas défini dans /etc/jev/jev.env. Toute machine du réseau Tailscale peut l'utiliser."
        : "Aucune clé n'est configurée et le serveur accepte les requêtes non authentifiées : définissez JEV_API_KEY sur le serveur puis ici.",
    );
  } catch (err) {
    if (err instanceof JevError && err.code === "unauthorized") {
      if (input.apiKey) {
        auth.detail = [auth.detail, "Requête sans clé correctement refusée (401)."].filter(Boolean).join(" ");
      } else {
        auth.status = "fail";
        auth.error = "Le serveur exige une clé API et aucune n'est configurée.";
        auth.hint = "Saisissez la valeur de JEV_API_KEY du serveur dans le champ « Clé API », ou définissez JEV_API_KEY dans le .env d'IATrano.";
        authBlocks = true;
      }
    } else if (!(err instanceof JevError && err.code === "bad_response")) {
      auth.warnings!.push(`Vérification du refus sans clé impossible : ${failure(err).error}`);
    }
  }
  auth.durationMs = elapsed(s);
  if (!auth.warnings!.length) delete auth.warnings;
  steps.push(auth);
  if (authBlocks) {
    rest(4);
    return finish();
  }

  // 5. Décision de test sur un exemple connu.
  s = performance.now();
  let decision: JevDecision | null = null;
  try {
    decision = await client.decide(JEV_TEST_SAMPLE.state, [JEV_TEST_SAMPLE.question]);
    const p = decision.answers[JEV_TEST_SAMPLE.question.name];
    const high = p > 0.5;
    steps.push({
      id: "decision",
      label: "Décision de test (POST /v1/systemone)",
      status: high ? "ok" : "fail",
      durationMs: elapsed(s),
      detail: `« ${JEV_TEST_SAMPLE.question.instructions} » sur « ${JEV_TEST_SAMPLE.state} » → P(oui) = ${p.toFixed(3)} · modèle ${decision.model}.`,
      error: high ? undefined : `Probabilité trop basse (${p.toFixed(3)} ≤ 0,5) pour un exemple dont la réponse attendue est « oui ».`,
      hint: high ? undefined : "Le service répond mais le modèle semble incorrect ou corrompu : vérifier le fichier GGUF chargé (sha256 dans /health).",
      // Réponse bien formée : la connexion fonctionne, seul le résultat est suspect.
      essential: false,
    });
  } catch (err) {
    const f = failure(err);
    steps.push({ id: "decision", label: "Décision de test (POST /v1/systemone)", status: "fail", durationMs: elapsed(s), error: f.error, hint: f.hint, essential: true });
    rest(5);
    return finish();
  }

  // 6. Routage : une requête par message d'exemple, avec les trois questions de routage.
  s = performance.now();
  const modes = input.routingModes ?? DEFAULT_MODES;
  const label = (m: (typeof ROUTING_MODES)[number]) => `${MODE_EMOJI[m]} ${MODE_LABELS[m]}`;
  try {
    const lines: string[] = [];
    const warnings: string[] = [];
    for (const sample of ROUTING_SAMPLES) {
      const r = await client.decide(sample.message, ROUTING_MODES.map((m) => ({ name: m, instructions: modes[m].question })));
      const chosen = ROUTING_MODES.filter((m) => r.answers[m] >= modes[m].threshold);
      const probs = ROUTING_MODES.map((m) => `${m} ${Math.round(r.answers[m] * 100)} %`).join(", ");
      lines.push(`${sample.label} → ${chosen.length ? chosen.map(label).join(" + ") : "réponse simple"} (${probs})`);
      const missing = sample.expected.filter((m) => !chosen.includes(m));
      if (missing.length) warnings.push(`« ${sample.label} » : mode attendu non retenu (${missing.map(label).join(", ")}). Ajustez la question ou le seuil.`);
    }
    steps.push({ id: "routing", label: "Test de routage (3 messages d'exemple)", status: "ok", durationMs: elapsed(s), detail: lines.join(" · "), warnings: warnings.length ? warnings : undefined, essential: false });
  } catch (err) {
    const f = failure(err);
    steps.push({ id: "routing", label: "Test de routage (3 messages d'exemple)", status: "fail", durationMs: elapsed(s), error: f.error, hint: f.hint, essential: false });
  }

  // 7. Performance : latence totale, temps d'inférence (Server-Timing) et latence réseau estimée.
  const { totalMs, serverMs } = decision.timing;
  steps.push({
    id: "perf",
    label: "Performance",
    status: "ok",
    durationMs: totalMs,
    detail:
      serverMs === null
        ? `Latence totale ${totalMs} ms (en-tête Server-Timing absent : temps d'inférence inconnu).`
        : `Latence totale ${totalMs} ms · inférence ${serverMs} ms · réseau et sérialisation ≈ ${Math.max(0, Math.round(totalMs - serverMs))} ms.`,
    warnings: totalMs > input.timeoutMs * 0.8 ? [`La latence approche le délai d'attente configuré (${input.timeoutMs / 1000} s) : augmentez-le.`] : undefined,
    essential: false,
  });
  return finish();
}
