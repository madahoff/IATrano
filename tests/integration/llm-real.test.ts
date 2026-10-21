// Tests contre un VRAI moteur IA (aucun mock). Exécutés seulement si LLM_TEST_URL est défini :
//   LLM_TEST_URL=http://localhost:11434 LLM_TEST_MODEL=qwen2.5:3b [LLM_TEST_THINKING_MODEL=qwen3:1.7b] pnpm test:integration
import { describe, expect, it } from "vitest";
import { OllamaProvider } from "@/lib/llm/ollama";
import type { ProviderChunk } from "@/lib/llm/types";

const url = process.env.LLM_TEST_URL;
const model = process.env.LLM_TEST_MODEL ?? "qwen2.5:3b";
const thinkingModel = process.env.LLM_TEST_THINKING_MODEL;

describe.skipIf(!url)(`Fournisseur réel (${url ?? "non configuré"})`, () => {
  const provider = new OllamaProvider({ kind: "OLLAMA", baseUrl: url ?? "", timeoutMs: 120_000 });

  it("se connecte et détecte le modèle demandé", async () => {
    const test = await provider.testConnection();
    expect(test.ok).toBe(true);
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toContain(model);
  });

  it("génère une réponse en streaming", async () => {
    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chatStream({ model, messages: [{ role: "user", content: "Réponds uniquement par le nombre : combien font 12 fois 7 ?" }], temperature: 0 })) chunks.push(c);
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("");
    expect(chunks.filter((c) => c.type === "text").length).toBeGreaterThan(0);
    expect(text).toContain("84");
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("annule une génération en cours", async () => {
    const ctrl = new AbortController();
    let received = 0;
    const run = async () => {
      for await (const c of provider.chatStream({ model, messages: [{ role: "user", content: "Écris un très long poème de 500 vers." }], signal: ctrl.signal })) {
        if (c.type === "text" && ++received === 5) ctrl.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ code: "aborted" });
    expect(received).toBe(5);
  });

  it.skipIf(!thinkingModel)(`renvoie un raisonnement distinct avec ${thinkingModel ?? "un modèle à Thinking"}`, async () => {
    const models = await provider.listModels();
    expect(models.find((m) => m.id === thinkingModel)?.capabilities.thinking).toBe("yes");
    const run = async (think: boolean) => {
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chatStream({ model: thinkingModel!, messages: [{ role: "user", content: "Combien font 17 + 25 ?" }], think })) chunks.push(c);
      return {
        thinking: chunks.filter((c) => c.type === "thinking").map((c) => (c as { delta: string }).delta).join(""),
        text: chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join(""),
      };
    };
    const on = await run(true);
    expect(on.thinking.length).toBeGreaterThan(0);
    expect(on.text).toContain("42");
    expect(on.text).not.toContain("<think>");
    const off = await run(false);
    expect(off.thinking).toBe("");
    expect(off.text).toContain("42");
  });
});
