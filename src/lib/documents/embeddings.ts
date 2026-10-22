import "server-only";
import type { AppSettings, DocumentSettings } from "@prisma/client";
import { db } from "@/lib/db";
import { fetchWithTimeout, readErrorBody } from "@/lib/llm/stream-utils";

// Embeddings (recherche sémantique) : Ollama /api/embed ou /v1/embeddings compatible OpenAI.
// Vecteurs normalisés (cosinus = produit scalaire), stockés en Float32 et mis en cache par empreinte de contenu :
// un passage déjà vectorisé n'est jamais recalculé, même dans un autre document ou une nouvelle version.

export type EmbeddingConfig = { kind: AppSettings["providerType"]; baseUrl: string; apiKey: string | null; model: string; timeoutMs: number };

export function embeddingConfig(app: AppSettings, docs: DocumentSettings): EmbeddingConfig | null {
  if (!docs.embeddingModel) return null;
  return { kind: app.providerType, baseUrl: (docs.embeddingBaseUrl ?? app.baseUrl).replace(/\/+$/, ""), apiKey: docs.embeddingBaseUrl ? null : app.apiKey, model: docs.embeddingModel, timeoutMs: Math.max(60_000, app.requestTimeoutMs) };
}

/** Préfixes de tâche recommandés par certaines familles de modèles (requête vs passage). */
export function taskPrefix(model: string, role: "query" | "document"): string {
  const m = model.toLowerCase();
  if (m.includes("embeddinggemma")) return role === "query" ? "task: search result | query: " : "title: none | text: ";
  if (m.includes("nomic")) return role === "query" ? "search_query: " : "search_document: ";
  if (/(^|[^a-z])e5([^a-z]|$)|multilingual-e5/.test(m)) return role === "query" ? "query: " : "passage: ";
  if (m.includes("mxbai") && role === "query") return "Represent this sentence for searching relevant passages: ";
  return "";
}

export function normalize(v: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export const toBytes = (v: Float32Array) => new Uint8Array(v.slice().buffer);
export const fromBytes = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function callEmbed(cfg: EmbeddingConfig, inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.kind === "OLLAMA") {
    const res = await fetchWithTimeout(`${cfg.baseUrl}/api/embed`, { method: "POST", headers, body: JSON.stringify({ model: cfg.model, input: inputs, truncate: true }) }, { baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, signal });
    if (!res.ok) throw new Error(`Embeddings (${res.status}) : ${await readErrorBody(res)}`);
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) throw new Error("Réponse d'embeddings invalide.");
    return data.embeddings.map(normalize);
  }
  const res = await fetchWithTimeout(`${cfg.baseUrl}/embeddings`, { method: "POST", headers, body: JSON.stringify({ model: cfg.model, input: inputs }) }, { baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, signal });
  if (!res.ok) throw new Error(`Embeddings (${res.status}) : ${await readErrorBody(res)}`);
  const data = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
  if (!Array.isArray(data.data) || data.data.length !== inputs.length) throw new Error("Réponse d'embeddings invalide.");
  return data.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
}

const cacheKey = (model: string, hash: string) => `embed:${model}:${hash}`;

/** Vectorise des passages (avec cache par empreinte) ; renvoie les vecteurs dans l'ordre des entrées. */
export async function embedDocuments(cfg: EmbeddingConfig, items: Array<{ hash: string; text: string }>, signal?: AbortSignal): Promise<{ vectors: Float32Array[]; reused: number }> {
  const keys = items.map((i) => cacheKey(cfg.model, i.hash));
  const cached = await db.documentCache.findMany({ where: { key: { in: keys } }, select: { key: true, data: true } });
  const byKey = new Map(cached.filter((c) => c.data).map((c) => [c.key, fromBytes(c.data!)]));
  const missing = items.map((item, i) => ({ item, i })).filter(({ i }) => !byKey.has(keys[i]));
  if (missing.length) {
    const prefix = taskPrefix(cfg.model, "document");
    const vectors = await callEmbed(cfg, missing.map(({ item }) => `${prefix}${item.text}`), signal);
    await db.documentCache.createMany({ data: missing.map(({ i }, j) => ({ key: keys[i], kind: "embed", data: toBytes(vectors[j]) })), skipDuplicates: true });
    missing.forEach(({ i }, j) => byKey.set(keys[i], vectors[j]));
  }
  return { vectors: keys.map((k) => byKey.get(k)!), reused: items.length - missing.length };
}

const queryCache = new Map<string, Float32Array>();

export async function embedQuery(cfg: EmbeddingConfig, query: string, signal?: AbortSignal): Promise<Float32Array> {
  const key = `${cfg.model}\n${query}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const [v] = await callEmbed(cfg, [`${taskPrefix(cfg.model, "query")}${query}`], signal);
  if (queryCache.size > 500) queryCache.clear();
  queryCache.set(key, v);
  return v;
}

/** Test de configuration : dimension du vecteur et latence. */
export async function testEmbeddings(cfg: EmbeddingConfig) {
  const started = Date.now();
  const [v] = await callEmbed(cfg, ["test de connexion"]);
  return { dimensions: v.length, latencyMs: Date.now() - started };
}
