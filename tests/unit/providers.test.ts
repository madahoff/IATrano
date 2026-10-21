// Tests des adaptateurs avec un fetch simulé (mocks strictement limités aux tests).
import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "@/lib/llm/ollama";
import { OpenAICompatibleProvider } from "@/lib/llm/openai-compatible";
import { ProviderError, type ProviderChunk } from "@/lib/llm/types";

function streamOf(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(route: Route) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => route(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function collect(gen: AsyncGenerator<ProviderChunk>) {
  const out: ProviderChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}
const join = (chunks: ProviderChunk[], type: "text" | "thinking") =>
  chunks.filter((c) => c.type === type).map((c) => (c as { delta: string }).delta).join("");

afterEach(() => vi.unstubAllGlobals());

const ollama = () => new OllamaProvider({ kind: "OLLAMA", baseUrl: "http://ollama:11434", timeoutMs: 2000 });
const openai = (apiKey?: string) => new OpenAICompatibleProvider({ kind: "OPENAI_COMPATIBLE", baseUrl: "http://lmstudio:1234", apiKey, timeoutMs: 2000 });

describe("OllamaProvider", () => {
  it("découvre les modèles et leurs capacités réelles", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/api/tags")) {
        return Response.json({
          models: [
            { name: "qwen2.5:3b", size: 1929912432, details: { family: "qwen2", parameter_size: "3.1B", quantization_level: "Q4_K_M" } },
            { name: "qwen3:1.7b", size: 1_400_000_000, details: { family: "qwen3" } },
          ],
        });
      }
      if (url.endsWith("/api/show")) {
        const model = JSON.parse(String(init?.body)).model as string;
        return Response.json({
          capabilities: model.startsWith("qwen3") ? ["completion", "thinking"] : ["completion", "tools"],
          model_info: { "qwen2.context_length": 32768 },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const models = await ollama().listModels();
    expect(models.map((m) => [m.id, m.capabilities.thinking])).toEqual([
      ["qwen2.5:3b", "no"],
      ["qwen3:1.7b", "yes"],
    ]);
    expect(models[0]).toMatchObject({ parameterSize: "3.1B", quantization: "Q4_K_M", contextLength: 32768 });
  });

  it("streame séparément le raisonnement natif et la réponse, et transmet think", async () => {
    const fetchMock = mockFetch(() =>
      new Response(
        streamOf([
          '{"message":{"thinking":"Je réfléchis"},"done":false}\n{"message":{"thinking":" encore"},"do',
          'ne":false}\n{"message":{"content":"Rép"},"done":false}\n',
          '{"message":{"content":"onse"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"stop","eval_count":7}\n',
        ]),
      ),
    );
    const chunks = await collect(ollama().chatStream({ model: "qwen3:1.7b", messages: [{ role: "user", content: "x" }], think: true }));
    expect(join(chunks, "thinking")).toBe("Je réfléchis encore");
    expect(join(chunks, "text")).toBe("Réponse");
    expect(chunks.at(-1)).toEqual({ type: "done", reason: "stop", evalCount: 7 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).think).toBe(true);
  });

  it("extrait les balises <think> laissées dans le contenu", async () => {
    mockFetch(() => new Response(streamOf(['{"message":{"content":"<thi"}}\n{"message":{"content":"nk>pensée</think>OK"}}\n{"done":true}\n'])));
    const chunks = await collect(ollama().chatStream({ model: "m", messages: [] }));
    expect(join(chunks, "thinking")).toBe("pensée");
    expect(join(chunks, "text")).toBe("OK");
  });

  it("signale un modèle absent et un modèle sans Thinking", async () => {
    mockFetch(() => Response.json({ error: "model 'x' not found" }, { status: 404 }));
    await expect(collect(ollama().chatStream({ model: "x", messages: [] }))).rejects.toMatchObject({ code: "model_not_found" });
    mockFetch(() => Response.json({ error: '"qwen2.5:3b" does not support thinking' }, { status: 400 }));
    await expect(collect(ollama().chatStream({ model: "qwen2.5:3b", messages: [], think: true }))).rejects.toMatchObject({ code: "thinking_unsupported" });
  });

  it("transforme une erreur en cours de flux en ProviderError", async () => {
    mockFetch(() => new Response(streamOf(['{"message":{"content":"a"}}\n{"error":"out of memory"}\n'])));
    await expect(collect(ollama().chatStream({ model: "m", messages: [] }))).rejects.toThrow(/out of memory/);
  });

  it("annule proprement une génération en cours", async () => {
    mockFetch((_u, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"message":{"content":"début"}}\n'));
            signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        }),
      );
    });
    const ctrl = new AbortController();
    const gen = ollama().chatStream({ model: "m", messages: [], signal: ctrl.signal });
    const first = await gen.next();
    expect(first.value).toEqual({ type: "text", delta: "début" });
    ctrl.abort();
    await expect(gen.next()).rejects.toMatchObject({ code: "aborted" });
  });

  it("détecte un flux bloqué (délai d'inactivité)", async () => {
    mockFetch(() => new Response(new ReadableStream({ start() {} })));
    const p = new OllamaProvider({ kind: "OLLAMA", baseUrl: "http://o:1", timeoutMs: 150 });
    await expect(collect(p.chatStream({ model: "m", messages: [] }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("teste la connexion et reconnaît un serveur qui n'est pas Ollama", async () => {
    mockFetch((url) => (url.endsWith("/api/version") ? Response.json({ version: "0.30.7" }) : Response.json({ models: [] })));
    expect(await ollama().testConnection()).toMatchObject({ ok: true, version: "0.30.7", modelCount: 0 });
    mockFetch(() => new Response("nope", { status: 404 }));
    const res = await ollama().testConnection();
    expect(res.ok).toBe(false);
    expect(res.hint).toContain("Compatible OpenAI");
  });

  it("traduit une connexion refusée", async () => {
    mockFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const res = await ollama().testConnection();
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toContain("Connexion refusée");
  });

  it("envoie le schéma JSON pour les sorties structurées", async () => {
    const f = mockFetch(() => Response.json({ message: { content: '{"questions":[]}' } }));
    await ollama().completeJson({ model: "m", messages: [] }, { type: "object" });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body)).format).toEqual({ type: "object" });
  });
});

describe("OpenAICompatibleProvider", () => {
  it("liste les modèles via /v1/models sans inventer de capacités", async () => {
    const f = mockFetch(() => Response.json({ data: [{ id: "qwen2.5-3b-instruct" }] }));
    const models = await openai("sk-local").listModels();
    expect(models[0]).toMatchObject({ id: "qwen2.5-3b-instruct", capabilities: { thinking: "unknown" } });
    expect(String(f.mock.calls[0][0])).toBe("http://lmstudio:1234/v1/models");
    expect((f.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe("Bearer sk-local");
  });

  it("lit le raisonnement (reasoning_content) et le contenu en SSE", async () => {
    const f = mockFetch(() =>
      new Response(
        streamOf([
          'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Bon"}}]}\n\ndata: {"choices":[{"delta":{"content":"jour"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const chunks = await collect(openai().chatStream({ model: "m", messages: [], think: true }));
    expect(join(chunks, "thinking")).toBe("hmm");
    expect(join(chunks, "text")).toBe("Bonjour");
    expect(chunks.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body)).chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("réessaie sans extension si le serveur refuse chat_template_kwargs", async () => {
    let call = 0;
    const f = mockFetch(() => {
      call++;
      if (call === 1) return Response.json({ error: { message: "Unrecognized request argument: chat_template_kwargs" } }, { status: 400 });
      return new Response(streamOf(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]));
    });
    const chunks = await collect(openai().chatStream({ model: "m", messages: [], think: false }));
    expect(join(chunks, "text")).toBe("ok");
    expect(JSON.parse(String(f.mock.calls[1][1]?.body)).chat_template_kwargs).toBeUndefined();
  });

  it("explique un refus d'authentification", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(openai().listModels()).rejects.toBeInstanceOf(ProviderError);
    const res = await openai().testConnection();
    expect(res.hint).toContain("clé d'API");
  });
});
