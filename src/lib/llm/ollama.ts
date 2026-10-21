import { fetchWithTimeout, readErrorBody, readLines } from "./stream-utils";
import { createThinkTagRouter } from "./think-parser";
import {
  ProviderError,
  type Capability,
  type ConnectionTest,
  type GenerateRequest,
  type LlmProvider,
  type ModelInfo,
  type ProviderChunk,
  type ProviderConfig,
} from "./types";

// Adaptateur Ollama : /api/version, /api/tags (découverte), /api/show (capacités), /api/chat (génération).

type TagsResponse = {
  models?: Array<{
    name: string;
    model?: string;
    size?: number;
    details?: { family?: string; parameter_size?: string; quantization_level?: string };
  }>;
};

type ShowResponse = {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
};

type ChatLine = {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  error?: string;
};

function cap(list: string[] | undefined, name: string): Capability {
  if (!list) return "unknown";
  return list.includes(name) ? "yes" : "no";
}

export class OllamaProvider implements LlmProvider {
  readonly kind = "OLLAMA" as const;
  readonly label = "Ollama";
  private readonly showCache = new Map<string, { at: number; data: ShowResponse }>();

  constructor(private readonly config: ProviderConfig) {}

  private url(path: string) {
    return `${this.config.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private opts(signal?: AbortSignal, timeoutMs = this.config.timeoutMs) {
    return { baseUrl: this.config.baseUrl, timeoutMs, signal };
  }

  async testConnection(): Promise<ConnectionTest> {
    const start = Date.now();
    try {
      const res = await fetchWithTimeout(this.url("/api/version"), { method: "GET" }, this.opts(undefined, 5000));
      if (!res.ok) {
        return {
          ok: false,
          kind: this.kind,
          baseUrl: this.config.baseUrl,
          latencyMs: Date.now() - start,
          error: `Réponse HTTP ${res.status} sur /api/version.`,
          hint: res.status === 404 ? "Ce serveur ne semble pas être Ollama. Essayez le type « Compatible OpenAI »." : undefined,
        };
      }
      const data = (await res.json().catch(() => ({}))) as { version?: string };
      if (!data.version) {
        return {
          ok: false,
          kind: this.kind,
          baseUrl: this.config.baseUrl,
          latencyMs: Date.now() - start,
          error: "Réponse inattendue : ce serveur n'est pas Ollama.",
          hint: "Si c'est LM Studio, llama.cpp ou vLLM, choisissez le type « Compatible OpenAI ».",
        };
      }
      const models = await this.listModels().catch(() => []);
      return {
        ok: true,
        kind: this.kind,
        baseUrl: this.config.baseUrl,
        version: data.version,
        latencyMs: Date.now() - start,
        modelCount: models.length,
        hint: models.length === 0 ? "Ollama répond mais aucun modèle n'est installé (ollama pull <modèle>)." : undefined,
      };
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError(String(err), "unreachable");
      return { ok: false, kind: this.kind, baseUrl: this.config.baseUrl, latencyMs: Date.now() - start, error: e.message, hint: e.hint };
    }
  }

  private async show(model: string): Promise<ShowResponse | null> {
    const hit = this.showCache.get(model);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
    try {
      const res = await fetchWithTimeout(
        this.url("/api/show"),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) },
        this.opts(undefined, 10_000),
      );
      if (!res.ok) return null;
      const data = (await res.json()) as ShowResponse;
      this.showCache.set(model, { at: Date.now(), data });
      return data;
    } catch {
      return null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetchWithTimeout(this.url("/api/tags"), { method: "GET" }, this.opts(undefined, 10_000));
    if (!res.ok) {
      throw new ProviderError(`Ollama a répondu ${res.status} sur /api/tags : ${await readErrorBody(res)}`, "http_error", undefined, res.status);
    }
    const data = (await res.json()) as TagsResponse;
    if (!Array.isArray(data.models)) throw new ProviderError("Réponse /api/tags invalide.", "bad_response");
    return Promise.all(
      data.models.map(async (m): Promise<ModelInfo> => {
        const info = await this.show(m.name);
        const ctxEntry = Object.entries(info?.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
        return {
          id: m.name,
          name: m.name,
          provider: this.kind,
          family: m.details?.family,
          parameterSize: m.details?.parameter_size,
          quantization: m.details?.quantization_level,
          sizeBytes: m.size,
          contextLength: typeof ctxEntry?.[1] === "number" ? ctxEntry[1] : undefined,
          capabilities: {
            thinking: cap(info?.capabilities, "thinking"),
            tools: cap(info?.capabilities, "tools"),
            vision: cap(info?.capabilities, "vision"),
          },
        };
      }),
    );
  }

  async *chatStream(req: GenerateRequest): AsyncGenerator<ProviderChunk> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
    if (req.think !== undefined) body.think = req.think;
    if (req.temperature !== undefined) body.options = { temperature: req.temperature };
    const res = await fetchWithTimeout(
      this.url("/api/chat"),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      this.opts(req.signal),
    );
    if (!res.ok || !res.body) {
      const detail = await readErrorBody(res);
      if (res.status === 404) {
        throw new ProviderError(`Le modèle « ${req.model} » n'est pas installé sur ce serveur Ollama.`, "model_not_found", "Actualisez la liste des modèles ou installez-le : ollama pull " + req.model, 404);
      }
      if (/does not support thinking/i.test(detail)) {
        throw new ProviderError(`Le modèle « ${req.model} » ne prend pas en charge le mode Thinking.`, "thinking_unsupported", undefined, res.status);
      }
      throw new ProviderError(`Erreur Ollama (${res.status}) : ${detail}`, "http_error", undefined, res.status);
    }
    const thinkTags = createThinkTagRouter();
    for await (const line of readLines(res.body, { idleTimeoutMs: this.config.timeoutMs, signal: req.signal, baseUrl: this.config.baseUrl })) {
      if (!line.trim()) continue;
      let data: ChatLine;
      try {
        data = JSON.parse(line) as ChatLine;
      } catch {
        continue;
      }
      if (data.error) throw new ProviderError(`Erreur Ollama : ${data.error}`, "http_error");
      if (data.message?.thinking) yield { type: "thinking", delta: data.message.thinking };
      if (data.message?.content) yield* thinkTags.push(data.message.content);
      if (data.done) {
        yield* thinkTags.flush();
        yield { type: "done", reason: data.done_reason, evalCount: data.eval_count };
        return;
      }
    }
    yield* thinkTags.flush();
    yield { type: "done", reason: "eof" };
  }

  async complete(req: GenerateRequest): Promise<string> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: false };
    if (req.think !== undefined) body.think = req.think;
    if (req.temperature !== undefined) body.options = { temperature: req.temperature };
    const res = await fetchWithTimeout(
      this.url("/api/chat"),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      this.opts(req.signal),
    );
    if (!res.ok) throw new ProviderError(`Erreur Ollama (${res.status}) : ${await readErrorBody(res)}`, "http_error", undefined, res.status);
    const data = (await res.json()) as ChatLine;
    return (data.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
}
