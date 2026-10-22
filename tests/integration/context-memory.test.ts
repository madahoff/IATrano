// Contexte, compaction et mémoire persistante : vraie base PostgreSQL, fournisseur LLM factice.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { ProviderError, type GenerateRequest, type LlmProvider, type ModelInfo, type ProviderChunk } from "@/lib/llm/types";
import type { StreamEvent } from "@/lib/chat/protocol";
import type { ContextUsageDTO } from "@/lib/context/types";
import { MEMORY_HEADER, SUMMARY_HEADER } from "@/lib/context/assemble";
import { getAppSettings } from "@/lib/settings/service";
import { createUser, jsonRequest, loginAs, params, resetDb } from "../support/fixtures";

const state: {
  requests: GenerateRequest[];
  jsonCalls: GenerateRequest[];
  json: (req: GenerateRequest) => Promise<string>;
  models: ModelInfo[];
  promptTokens: number | undefined;
} = { requests: [], jsonCalls: [], json: async () => "{}", models: [], promptTokens: undefined };

const fakeProvider: LlmProvider = {
  kind: "OLLAMA",
  label: "Fake",
  testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://fake", latencyMs: 1 }),
  listModels: async () => state.models,
  chatStream: async function* (req): AsyncGenerator<ProviderChunk> {
    state.requests.push(req);
    yield { type: "text", delta: "Réponse de test." };
    yield { type: "done", reason: "stop", evalCount: 4, promptTokens: state.promptTokens };
  },
  complete: async () => "Titre",
  completeJson: async (req) => {
    state.jsonCalls.push(req);
    return state.json(req);
  },
};

vi.mock("@/lib/llm/registry", () => ({
  createProvider: () => fakeProvider,
  buildProvider: () => fakeProvider,
  PROVIDER_LABELS: { OLLAMA: "Ollama", OPENAI_COMPATIBLE: "OpenAI" },
}));
vi.mock("@/lib/llm/discovery", () => ({
  getModels: async () => ({ provider: { kind: "OLLAMA", reachable: true }, models: state.models, fetchedAt: new Date().toISOString() }),
  invalidateModelCache: () => {},
}));

const chatRoute = await import("@/app/api/chat/route");
const contextRoute = await import("@/app/api/context/route");
const compactRoute = await import("@/app/api/conversations/[id]/compact/route");
const memoriesRoute = await import("@/app/api/memories/route");
const memoryRoute = await import("@/app/api/memories/[id]/route");
const memorySettingsRoute = await import("@/app/api/memories/settings/route");
const adminModelsRoute = await import("@/app/api/admin/context/models/route");

const model = (id: string, contextLength?: number): ModelInfo => ({ id, name: id, provider: "OLLAMA", contextLength, capabilities: { thinking: "no", tools: "no", vision: "no" } });

// Ces scénarios portent sur le contexte : la recherche Web (testée dans web-search.test.ts) est coupée.
async function chat(body: Record<string, unknown>) {
  const res = await chatRoute.POST(jsonRequest("POST", "/api/chat", { webSearch: false, ...body }), {});
  const events: StreamEvent[] = [];
  const text = await res.text();
  for (const line of text.split("\n")) if (line.trim()) events.push(JSON.parse(line));
  return events;
}

async function usage(conversationId: string | null, m = "qwen:3b"): Promise<{ status: number; usage?: ContextUsageDTO }> {
  const qs = new URLSearchParams({ model: m, ...(conversationId ? { conversationId } : {}) });
  const res = await contextRoute.GET(jsonRequest("GET", `/api/context?${qs}`), {});
  return { status: res.status, usage: res.ok ? (await res.json()).usage : undefined };
}

async function compact(id: string, m = "qwen:3b") {
  const res = await compactRoute.POST(jsonRequest("POST", `/api/conversations/${id}/compact`, { model: m }), params({ id }));
  return { status: res.status, body: await res.json() };
}

const VALID_SUMMARY = JSON.stringify({
  objective: "Mettre en place le déploiement Dokploy de l'application",
  constraints: ["Répondre en français"],
  decisions: ["Base PostgreSQL 16 dans Docker"],
  facts: ["Le serveur Ollama écoute sur le port 11434"],
  state: ["Le Dockerfile est écrit"],
  nextSteps: ["Configurer les variables d'environnement"],
});

const filler = (i: number) => `Échange numéro ${i} : ${"détail technique sur la configuration du serveur et des conteneurs ".repeat(25)}`;

async function seedLongConversation(userId: string, pairs = 8) {
  const conv = await db.conversation.create({ data: { userId, title: "Long", model: "qwen:3b" } });
  const t0 = Date.now() - 1_000_000;
  for (let i = 0; i < pairs; i++) {
    const intro = i === 0 ? "Je veux mettre en place le déploiement Dokploy de l'application. " : "";
    await db.message.create({ data: { conversationId: conv.id, role: "USER", content: `Question ${i}. ${intro}${filler(i)}`, createdAt: new Date(t0 + i * 2000) } });
    await db.message.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: `Réponse ${i}. ${filler(i)}${i === 1 ? "\nVoir https://docs.dokploy.com/install et compose.yaml" : ""}`, createdAt: new Date(t0 + i * 2000 + 1000) } });
  }
  return conv;
}

let userId = "";
beforeEach(async () => {
  await resetDb();
  const u = await createUser();
  userId = u.id;
  await loginAs(u.id);
  state.requests = [];
  state.jsonCalls = [];
  state.json = async () => VALID_SUMMARY;
  state.models = [model("qwen:3b", 32768), model("tiny:1b", 2048)];
  state.promptTokens = undefined;
});

describe("compteur de contexte", () => {
  it("nouvelle conversation : fenêtre réelle imposée au moteur, consommation de base non nulle, estimation signalée", async () => {
    const { usage: u } = await usage(null);
    expect(u).toMatchObject({ window: 32768, reserve: 1024, capacity: 31744, windowSource: "provider", providerMax: 32768, estimated: true, state: "normal" });
    expect(u!.used).toBeGreaterThan(50);
    // Sans aucun souvenir, seule la consigne « mémoire gérée par l'application » occupe la part mémoire.
    expect(u!.parts.memory).toBeGreaterThan(0);
    expect(u!.parts.memory).toBeLessThan(80);
    expect(u!.parts.system + u!.parts.memory).toBe(u!.usedRaw);
  });

  it("après un message : num_ctx envoyé, mesure du fournisseur enregistrée, compteur recalibré et augmenté", async () => {
    state.promptTokens = 400;
    const events = await chat({ action: "send", content: "Bonjour, explique-moi Docker.", model: "qwen:3b", thinking: false });
    expect(state.requests[0].numCtx).toBe(32768);
    const ctxEv = events.find((e) => e.type === "context") as Extract<StreamEvent, { type: "context" }>;
    expect(ctxEv).toMatchObject({ window: 32768, capacity: 31744, dropped: 0, rag: 0 });
    expect(events.find((e) => e.type === "context_measured")).toMatchObject({ promptTokens: 400, completionTokens: 4 });
    const start = events[0] as Extract<StreamEvent, { type: "start" }>;
    const msg = await db.message.findUniqueOrThrow({ where: { id: start.assistantMessageId } });
    expect(msg).toMatchObject({ promptTokens: 400, completionTokens: 4 });
    expect((msg.contextUsage as { estimated: number }).estimated).toBe(ctxEv.promptTokens);

    const { usage: u } = await usage(start.conversationId);
    expect(u!.lastRequest).toMatchObject({ promptTokens: 400, completionTokens: 4 });
    expect(u!.calibration?.measured).toBe(400);
    expect(u!.messages).toMatchObject({ total: 2, sent: 2, summarized: 0, dropped: 0 });
    expect(u!.usedRaw).toBeGreaterThan(ctxEv.promptTokens);
  });

  it("changement de modèle : la capacité et le pourcentage sont recalculés, les messages en trop sont signalés", async () => {
    const conv = await seedLongConversation(userId, 3);
    const big = (await usage(conv.id, "qwen:3b")).usage!;
    const small = (await usage(conv.id, "tiny:1b")).usage!;
    expect(small.window).toBe(2048);
    expect(small.capacity).toBe(1024);
    expect(small.percent).toBeGreaterThan(big.percent);
    expect(small.messages.dropped).toBeGreaterThan(0);
    expect(big.messages.dropped).toBe(0);
  });

  it("fenêtre manuelle par modèle (administration) prise en compte", async () => {
    const admin = await createUser("ADMIN");
    await loginAs(admin.id);
    const res = await adminModelsRoute.PUT(jsonRequest("PUT", "/api/admin/context/models", { model: "qwen:3b", contextWindow: 16384, responseReserve: 2048 }), {});
    expect(res.status).toBe(200);
    expect((await usage(null)).usage).toMatchObject({ window: 16384, reserve: 2048, capacity: 14336, windowSource: "manual" });
    await loginAs(userId);
    const denied = await adminModelsRoute.PUT(jsonRequest("PUT", "/api/admin/context/models", { model: "qwen:3b", contextWindow: 4096 }), {});
    expect(denied.status).toBe(403);
  });

  it("refuse la conversation d'un autre utilisateur", async () => {
    const other = await createUser();
    const conv = await seedLongConversation(other.id, 1);
    expect((await usage(conv.id)).status).toBe(404);
    expect((await compact(conv.id)).status).toBe(404);
  });
});

describe("compaction", () => {
  it("résume les anciens échanges, conserve tout l'historique et réduit le contexte", async () => {
    const conv = await seedLongConversation(userId);
    const before = (await usage(conv.id)).usage!;
    const { status, body } = await compact(conv.id);
    expect(status).toBe(200);
    expect(body.result).toMatchObject({ status: "compacted", version: 1 });
    expect(body.result.tokensAfter).toBeLessThan(body.result.tokensBefore);

    // Aucun message supprimé ni modifié.
    expect(await db.message.count({ where: { conversationId: conv.id } })).toBe(16);
    const after: ContextUsageDTO = body.usage;
    expect(after.summary).toMatchObject({ version: 1, trigger: "manual" });
    expect(after.summary!.sections.objective).toContain("Dokploy");
    expect(after.summary!.sections.references).toContainEqual({ type: "url", label: "https://docs.dokploy.com/install", url: "https://docs.dokploy.com/install" });
    expect(after.messages.summarized).toBeGreaterThan(0);
    expect(after.used).toBeLessThan(before.used);
    // Le résumé est demandé avec la même fenêtre que les réponses.
    expect(state.jsonCalls[0].numCtx).toBe(32768);
    const conv2 = await db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conv2.compactionStatus).toBe("SUCCEEDED");
  });

  it("la conversation continue avec le résumé à la place des anciens messages", async () => {
    const conv = await seedLongConversation(userId);
    await compact(conv.id);
    await chat({ action: "send", conversationId: conv.id, content: "Et maintenant ?", model: "qwen:3b", thinking: false });
    const sent = state.requests[0].messages;
    expect(sent[0].content).toContain(SUMMARY_HEADER);
    expect(sent[0].content).toContain("Base PostgreSQL 16 dans Docker");
    // Les anciens tours ne sont plus envoyés comme messages (seules leurs demandes sont citées dans le résumé).
    expect(sent.slice(1).some((m) => m.content.startsWith("Question 0."))).toBe(false);
    expect(sent.at(-1)?.content).toBe("Et maintenant ?");
    expect(sent.some((m) => m.content.startsWith("Réponse 7."))).toBe(true);
  });

  it("relancée sans nouveaux messages : aucune nouvelle version (pas de doublon)", async () => {
    const conv = await seedLongConversation(userId);
    await compact(conv.id);
    const again = await compact(conv.id);
    expect(again.body.result.status).toBe("nothing");
    expect(await db.contextSummary.count({ where: { conversationId: conv.id } })).toBe(1);
  });

  it("résumé invalide : rejeté, contexte précédent conservé, erreur explicite", async () => {
    const conv = await seedLongConversation(userId);
    await compact(conv.id);
    for (let i = 8; i < 12; i++) {
      await db.message.create({ data: { conversationId: conv.id, role: i % 2 ? "ASSISTANT" : "USER", content: filler(i), createdAt: new Date(Date.now() - 100_000 + i * 1000) } });
    }
    state.json = async () => '{"objective":"","constraints":[],"decisions":[],"facts":[],"state":[],"nextSteps":[]}';
    const { status, body } = await compact(conv.id);
    expect(status).toBe(422);
    expect(body.error.message).toMatch(/Résumé rejeté/);
    expect(state.jsonCalls.length).toBeGreaterThanOrEqual(3); // 1er succès + 2 essais rejetés
    const active = await db.contextSummary.findMany({ where: { conversationId: conv.id, status: "ACTIVE" } });
    expect(active.map((s) => s.version)).toEqual([1]);
    const c = await db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c.compactionStatus).toBe("FAILED");
    expect((await usage(conv.id)).usage!.compaction).toMatchObject({ status: "FAILED" });
  });

  it("génération interrompue ou panne du fournisseur : aucun résumé, état cohérent, nouvelle tentative possible", async () => {
    const conv = await seedLongConversation(userId);
    state.json = async () => {
      throw new ProviderError("Génération annulée.", "aborted");
    };
    expect((await compact(conv.id)).status).toBe(499);
    state.json = async () => {
      throw new ProviderError("Connexion refusée", "unreachable");
    };
    expect((await compact(conv.id)).status).toBe(502);
    expect(await db.contextSummary.count({ where: { conversationId: conv.id } })).toBe(0);
    state.json = async () => VALID_SUMMARY;
    expect((await compact(conv.id)).status).toBe(200);
  });

  it("verrou : pas de compaction concurrente", async () => {
    const conv = await seedLongConversation(userId);
    await db.conversation.update({ where: { id: conv.id }, data: { compactionStatus: "RUNNING", compactionStartedAt: new Date() } });
    expect((await compact(conv.id)).status).toBe(409);
  });

  it("édition d'un message couvert par le résumé : le résumé est invalidé, l'historique brut reprend", async () => {
    const conv = await seedLongConversation(userId);
    await compact(conv.id);
    const first = await db.message.findFirstOrThrow({ where: { conversationId: conv.id, role: "USER" }, orderBy: { createdAt: "asc" } });
    await chat({ action: "edit", conversationId: conv.id, messageId: first.id, content: "Nouvelle question", model: "qwen:3b", thinking: false });
    expect(await db.contextSummary.count({ where: { conversationId: conv.id, status: "ACTIVE" } })).toBe(0);
    expect(state.requests[0].messages[0].content).not.toContain(SUMMARY_HEADER);
  });

  it("compaction automatique après une réponse au-delà du seuil", async () => {
    const conv = await seedLongConversation(userId);
    await getAppSettings();
    await db.appSettings.update({ where: { id: 1 }, data: { contextAutoCompactPct: 5 } });
    const events = await chat({ action: "send", conversationId: conv.id, content: "Suite", model: "qwen:3b", thinking: false });
    expect(events.filter((e) => e.type === "compaction").map((e) => (e as { status: string }).status)).toEqual(["running", "done"]);
    expect(await db.contextSummary.findFirst({ where: { conversationId: conv.id, status: "ACTIVE" } })).toMatchObject({ trigger: "auto" });
  });

  it("sources Web citées conservées avec leur URL dans le résumé", async () => {
    const conv = await seedLongConversation(userId);
    const answer = await db.message.findFirstOrThrow({ where: { conversationId: conv.id, role: "ASSISTANT" }, orderBy: { createdAt: "asc" } });
    await db.webSearch.create({
      data: {
        messageId: answer.id,
        question: "q",
        mode: "auto",
        provider: "SEARXNG",
        status: "DONE",
        queries: ["q"],
        cited: [1],
        limitations: [],
        sources: [
          { n: 1, url: "https://www.postgresql.org/docs/16/", title: "PostgreSQL 16 Documentation" },
          { n: 2, url: "https://non-cite.example", title: "Non citée" },
        ],
      },
    });
    const { body } = await compact(conv.id);
    const refs = body.usage.summary.sections.references;
    expect(refs).toContainEqual({ type: "source", label: "PostgreSQL 16 Documentation", url: "https://www.postgresql.org/docs/16/" });
    expect(JSON.stringify(refs)).not.toContain("non-cite.example");
  });
});

describe("mémoire persistante", () => {
  const post = (body: unknown) => memoriesRoute.POST(jsonRequest("POST", "/api/memories", body), {});
  const list = async () => (await (await memoriesRoute.GET(jsonRequest("GET", "/api/memories"), {})).json()).memories as Array<{ id: string; content: string }>;

  it("création, modification, suppression ; refus des secrets", async () => {
    const created = await post({ kind: "PREFERENCE", content: "L'utilisateur préfère des réponses concises." });
    expect(created.status).toBe(201);
    const { memory } = await created.json();
    const patched = await memoryRoute.PATCH(jsonRequest("PATCH", `/api/memories/${memory.id}`, { content: "L'utilisateur préfère des réponses détaillées." }), params({ id: memory.id }));
    expect((await patched.json()).memory.content).toBe("L'utilisateur préfère des réponses détaillées.");
    expect((await post({ kind: "FACT", content: "Mon mot de passe est hunter2" })).status).toBe(400);
    expect((await post({ kind: "PROJECT", content: "Sans nom" })).status).toBe(400);
    const del = await memoryRoute.DELETE(jsonRequest("DELETE", `/api/memories/${memory.id}`), params({ id: memory.id }));
    expect(del.status).toBe(200);
    expect(await list()).toHaveLength(0);
  });

  it("doublon : la mémoire existante est mise à jour plutôt que dupliquée", async () => {
    await post({ kind: "FACT", content: "L'utilisateur déploie ses applications avec Dokploy." });
    const dup = await post({ kind: "FACT", content: "L'utilisateur déploie ses applications avec Dokploy" });
    expect((await dup.json()).duplicateOf).toBe(true);
    expect(await list()).toHaveLength(1);
  });

  it("isolation stricte entre utilisateurs", async () => {
    const { memory } = await (await post({ kind: "FACT", content: "Secret professionnel : projet Atlas" })).json();
    const other = await createUser();
    await loginAs(other.id);
    expect(await list()).toHaveLength(0);
    expect((await memoryRoute.PATCH(jsonRequest("PATCH", `/api/memories/${memory.id}`, { content: "piraté" }), params({ id: memory.id }))).status).toBe(404);
    expect((await memoryRoute.DELETE(jsonRequest("DELETE", `/api/memories/${memory.id}`), params({ id: memory.id }))).status).toBe(404);
    expect((await (await memoriesRoute.DELETE(jsonRequest("DELETE", "/api/memories", { confirm: true }), {})).json()).deleted).toBe(0);
    await loginAs(userId);
    expect((await list())[0].content).toBe("Secret professionnel : projet Atlas");
  });

  it("injection sélective dans le prompt, identifiée comme mémoire ; désactivable", async () => {
    await post({ kind: "PREFERENCE", content: "L'utilisateur veut être tutoyé." });
    await post({ kind: "FACT", content: "L'utilisateur fait de la plongée sous-marine." });
    await chat({ action: "send", content: "Comment configurer PostgreSQL ?", model: "qwen:3b", thinking: false });
    const system = state.requests[0].messages[0].content;
    expect(system).toContain(MEMORY_HEADER);
    expect(system).toContain("tutoyé");
    expect(system).not.toContain("plongée");
    expect(state.requests[0].messages.at(-1)?.content).toBe("Comment configurer PostgreSQL ?");

    await memorySettingsRoute.PATCH(jsonRequest("PATCH", "/api/memories/settings", { memoryEnabled: false }), {});
    await chat({ action: "send", content: "Et MySQL ?", model: "qwen:3b", thinking: false });
    expect(state.requests[1].messages[0].content).not.toContain(MEMORY_HEADER);
  });

  it("enregistrement automatique sur demande explicite, et correction d'une mémoire existante", async () => {
    const { memory } = await (await post({ kind: "FACT", content: "L'utilisateur utilise MySQL." })).json();
    state.json = async (req) => {
      expect(req.messages[1].content).toContain("M1 [personnel · FACT] L'utilisateur utilise MySQL.");
      return JSON.stringify({
        actions: [
          { action: "update", ref: "M1", content: "L'utilisateur utilise PostgreSQL.", evidence: "En fait j'utilise PostgreSQL, pas MySQL" },
          { action: "add", kind: "PREFERENCE", content: "L'utilisateur veut des exemples en TypeScript.", evidence: "je veux des exemples en TypeScript" },
          { action: "add", kind: "FACT", content: "Son mot de passe est azerty123", evidence: "je veux des exemples" },
        ],
      });
    };
    const events = await chat({ action: "send", content: "En fait j'utilise PostgreSQL, pas MySQL. Retiens aussi que je veux des exemples en TypeScript.", model: "qwen:3b", thinking: false });
    expect(events.find((e) => e.type === "memory")).toMatchObject({ saved: ["L'utilisateur veut des exemples en TypeScript."], updated: ["L'utilisateur utilise PostgreSQL."], removed: 0 });
    const all = await db.memory.findMany({ where: { userId, status: "ACTIVE" } });
    expect(all).toHaveLength(2);
    // L'ancienne version est conservée comme historique, jamais injectée.
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).status).toBe("SUPERSEDED");
    expect(all.some((m) => m.content === "L'utilisateur utilise PostgreSQL.")).toBe(true);
    expect(all.some((m) => /azerty/.test(m.content))).toBe(false);
  });

  it("aucun appel d'extraction pour une question ordinaire", async () => {
    await chat({ action: "send", content: "Quelle heure est-il à Tokyo ?", model: "qwen:3b", thinking: false });
    expect(state.jsonCalls).toHaveLength(0);
  });
});
