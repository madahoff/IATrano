import { fetchWithTimeout, readErrorBody, readLines } from "./stream-utils";
import { createThinkTagRouter } from "./think-parser";
import {
  ProviderError,
  type ConnectionTest,
  type GenerateRequest,
  type LlmProvider,
  type ModelInfo,
  type ProviderChunk,
  type ProviderConfig,
} from "./types";

// Adaptateur générique pour les serveurs exposant l'API OpenAI : LM Studio, llama.cpp (llama-server),
// vLLM, LocalAI, Jan… Utilise /v1/models et /v1/chat/completions (SSE).
// Le raisonnement est lu dans delta.reasoning_content / delta.reasoning (llama.cpp, vLLM, LM Studio),
// ou extrait des balises <think> si le serveur le laisse dans le contenu.

type ModelsResponse = { data?: Array<{ id: string; owned_by?: string }> };

type SseChunk = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { completion_tokens?: number };
  error?: { message?: string } | string;
};

export function apiRoot(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly kind = "OPENAI_COMPATIBLE" as const;
  readonly label = "Compatible OpenAI";

  constructor(private readonly config: ProviderConfig) {}

  private url(path: string) {
    return `${apiRoot(this.config.baseUrl)}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) h.authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private opts(signal?: AbortSignal, timeoutMs = this.config.timeoutMs) {
    return { baseUrl: this.config.baseUrl, timeoutMs, signal, headers: this.headers() };
  }

  async testConnection(): Promise<ConnectionTest> {
    const start = Date.now();
    try {
      const models = await this.listModels(5000);
      return {
        ok: true,
        kind: this.kind,
        baseUrl: this.config.baseUrl,
        latencyMs: Date.now() - start,
        modelCount: models.length,
        hint: models.length === 0 ? "Le serveur répond mais n'expose aucun modèle (chargez un modèle dans LM Studio / llama.cpp)." : undefined,
      };
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError(String(err), "unreachable");
      return { ok: false, kind: this.kind, baseUrl: this.config.baseUrl, latencyMs: Date.now() - start, error: e.message, hint: e.hint };
    }
  }

  async listModels(timeoutMs = 10_000): Promise<ModelInfo[]> {
    const res = await fetchWithTimeout(this.url("/models"), { method: "GET" }, this.opts(undefined, timeoutMs));
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("Le serveur refuse l'accès (clé d'API manquante ou invalide).", "http_error", "Renseignez la clé d'API dans l'administration.", res.status);
    }
    if (!res.ok) {
      throw new ProviderError(
        `Réponse HTTP ${res.status} sur ${new URL(this.url("/models")).pathname} : ${await readErrorBody(res)}`,
        "http_error",
        res.status === 404 ? "Ce serveur n'expose pas l'API OpenAI à cette adresse. Si c'est Ollama, choisissez le type « Ollama »." : undefined,
        res.status,
      );
    }
    const data = (await res.json().catch(() => null)) as ModelsResponse | null;
    if (!data || !Array.isArray(data.data)) throw new ProviderError("Réponse /v1/models invalide.", "bad_response");
    return data.data
      .filter((m) => typeof m.id === "string")
      .map((m) => ({
        id: m.id,
        name: m.id,
        provider: this.kind,
        // L'API OpenAI ne décrit pas les capacités : elles restent « inconnues » plutôt que supposées.
        capabilities: { thinking: "unknown", tools: "unknown", vision: "unknown" },
      }));
  }

  private body(req: GenerateRequest, stream: boolean, withExtras: boolean) {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // Interrupteur de raisonnement pour les gabarits Qwen3 / DeepSeek (llama.cpp, vLLM, SGLang).
    if (withExtras && req.think !== undefined) body.chat_template_kwargs = { enable_thinking: req.think };
    return JSON.stringify(body);
  }

  private async post(req: GenerateRequest, stream: boolean): Promise<Response> {
    let res = await fetchWithTimeout(this.url("/chat/completions"), { method: "POST", body: this.body(req, stream, true) }, this.opts(req.signal));
    // Certains serveurs stricts refusent les champs inconnus : nouvel essai sans extension.
    if ((res.status === 400 || res.status === 422) && req.think !== undefined) {
      const detail = await readErrorBody(res);
      if (/chat_template_kwargs|unrecognized|extra/i.test(detail)) {
        res = await fetchWithTimeout(this.url("/chat/completions"), { method: "POST", body: this.body(req, stream, false) }, this.opts(req.signal));
      } else {
        throw new ProviderError(`Erreur du serveur IA (${res.status}) : ${detail}`, "http_error", undefined, res.status);
      }
    }
    if (!res.ok) {
      const detail = await readErrorBody(res);
      if (res.status === 404 || /model.*(not found|does not exist)/i.test(detail)) {
        throw new ProviderError(`Le modèle « ${req.model} » est introuvable sur le serveur.`, "model_not_found", "Actualisez la liste des modèles.", res.status);
      }
      throw new ProviderError(`Erreur du serveur IA (${res.status}) : ${detail}`, "http_error", undefined, res.status);
    }
    return res;
  }

  async *chatStream(req: GenerateRequest): AsyncGenerator<ProviderChunk> {
    const res = await this.post(req, true);
    if (!res.body) throw new ProviderError("Réponse vide du serveur IA.", "bad_response");
    const thinkTags = createThinkTagRouter();
    let evalCount: number | undefined;
    let finish: string | undefined;
    for await (const line of readLines(res.body, { idleTimeoutMs: this.config.timeoutMs, signal: req.signal, baseUrl: this.config.baseUrl })) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") break;
      let data: SseChunk;
      try {
        data = JSON.parse(payload) as SseChunk;
      } catch {
        continue;
      }
      if (data.error) {
        const msg = typeof data.error === "string" ? data.error : data.error.message;
        throw new ProviderError(`Erreur du serveur IA : ${msg ?? "inconnue"}`, "http_error");
      }
      const choice = data.choices?.[0];
      const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (reasoning) yield { type: "thinking", delta: reasoning };
      const content = choice?.delta?.content;
      if (content) yield* thinkTags.push(content);
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (data.usage?.completion_tokens) evalCount = data.usage.completion_tokens;
    }
    yield* thinkTags.flush();
    yield { type: "done", reason: finish, evalCount };
  }

  async complete(req: GenerateRequest): Promise<string> {
    const res = await this.post(req, false);
    const data = (await res.json()) as SseChunk;
    return (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
}
