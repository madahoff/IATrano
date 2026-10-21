import "server-only";
import { getAppSettings, providerConfigFrom } from "@/lib/settings/service";
import { buildProvider, createProvider } from "./registry";
import { ProviderError, type ModelInfo, type ProviderKind } from "./types";
import { inDocker } from "./url";

export type ModelsSnapshot = {
  provider: { kind: ProviderKind; reachable: boolean; error?: string; hint?: string };
  models: ModelInfo[];
  fetchedAt: string;
};

// Cache court : la liste n'est jamais inventée, elle reflète le dernier appel réel au fournisseur.
const TTL_MS = 30_000;
let cache: { key: string; at: number; snapshot: ModelsSnapshot } | null = null;
let inflight: Promise<ModelsSnapshot> | null = null;

export async function getModels(opts: { refresh?: boolean } = {}): Promise<ModelsSnapshot> {
  const settings = await getAppSettings();
  const config = providerConfigFrom(settings);
  const key = `${config.kind}|${config.baseUrl}|${settings.updatedAt.getTime()}`;
  if (!opts.refresh && cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.snapshot;
  if (inflight && !opts.refresh) return inflight;
  inflight = (async () => {
    const provider = createProvider(config);
    let snapshot: ModelsSnapshot;
    try {
      const models = await provider.listModels();
      models.sort((a, b) => a.name.localeCompare(b.name));
      snapshot = { provider: { kind: config.kind, reachable: true }, models, fetchedAt: new Date().toISOString() };
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError(String(err), "unreachable");
      snapshot = {
        provider: { kind: config.kind, reachable: false, error: e.message, hint: e.hint },
        models: [],
        fetchedAt: new Date().toISOString(),
      };
    }
    cache = { key, at: Date.now(), snapshot };
    return snapshot;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function invalidateModelCache() {
  cache = null;
}

export type DetectionResult = {
  kind: ProviderKind;
  baseUrl: string;
  ok: boolean;
  version?: string;
  modelCount?: number;
  models?: string[];
  error?: string;
};

/**
 * Détection automatique côté serveur : sonde les adresses usuelles des moteurs locaux depuis le serveur Next.js.
 * (Le navigateur ne peut pas découvrir les modèles d'une autre machine ; seul le serveur le peut.)
 */
export async function detectProviders(extraUrls: string[] = []): Promise<DetectionResult[]> {
  const hosts = inDocker() ? ["host.docker.internal", "localhost"] : ["localhost", "host.docker.internal"];
  const candidates: Array<{ kind: ProviderKind; baseUrl: string }> = [];
  for (const h of hosts) {
    candidates.push({ kind: "OLLAMA", baseUrl: `http://${h}:11434` });
    candidates.push({ kind: "OPENAI_COMPATIBLE", baseUrl: `http://${h}:1234/v1` });
    candidates.push({ kind: "OPENAI_COMPATIBLE", baseUrl: `http://${h}:8080/v1` });
  }
  for (const url of extraUrls) {
    candidates.unshift({ kind: "OLLAMA", baseUrl: url }, { kind: "OPENAI_COMPATIBLE", baseUrl: url });
  }
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const k = `${c.kind}|${c.baseUrl}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const results = await Promise.all(
    unique.map(async (c): Promise<DetectionResult> => {
      const provider = buildProvider({ ...c, timeoutMs: 3000 });
      const test = await provider.testConnection();
      if (!test.ok) return { ...c, ok: false, error: test.error };
      const models = await provider.listModels().catch(() => []);
      return { ...c, ok: true, version: test.version, modelCount: models.length, models: models.map((m) => m.id).slice(0, 20) };
    }),
  );
  // Un serveur Ollama expose aussi /v1 : on ne garde que l'entrée Ollama (plus riche) pour la même adresse.
  const ollamaHosts = new Set(results.filter((r) => r.ok && r.kind === "OLLAMA").map((r) => new URL(r.baseUrl).host));
  return results.filter((r) => !(r.kind === "OPENAI_COMPATIBLE" && ollamaHosts.has(new URL(r.baseUrl).host)));
}
