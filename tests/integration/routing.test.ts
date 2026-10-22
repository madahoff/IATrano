// Routage par JEV de bout en bout : /api/chat/routing puis /api/chat, base réelle, faux serveur JEV en HTTP,
// fournisseur LLM factice et pipeline de recherche simulé (aucun accès réseau externe).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { GenerateRequest, LlmProvider, ModelInfo, ProviderChunk } from "@/lib/llm/types";
import type { StreamEvent } from "@/lib/chat/protocol";
import { createUser, jsonRequest, loginAs, resetDb } from "../support/fixtures";
import { startFakeJev, type FakeJev } from "../support/fake-jev";
import { invalidateJevSettings } from "@/lib/jev/settings";
import { resetRateLimit } from "@/lib/rate-limit";

const llm: { requests: GenerateRequest[] } = { requests: [] };
const fakeProvider: LlmProvider = {
  kind: "OLLAMA",
  label: "Fake",
  testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://fake", latencyMs: 1 }),
  listModels: async () => models,
  chatStream: (req) => {
    llm.requests.push(req);
    return (async function* (): AsyncGenerator<ProviderChunk> {
      yield { type: "text", delta: "Réponse." };
      yield { type: "done", reason: "stop" };
    })();
  },
  complete: async () => "Titre",
  completeJson: async () => "{}",
};
const models: ModelInfo[] = [{ id: "qwen3:32b", name: "qwen3:32b", provider: "OLLAMA", capabilities: { thinking: "yes", tools: "yes", vision: "no" } }];

vi.mock("@/lib/llm/registry", () => ({ createProvider: () => fakeProvider, buildProvider: () => fakeProvider, PROVIDER_LABELS: { OLLAMA: "Ollama", OPENAI_COMPATIBLE: "OpenAI" } }));
vi.mock("@/lib/llm/discovery", () => ({
  getModels: async () => ({ provider: { kind: "OLLAMA", reachable: true }, models, fetchedAt: new Date().toISOString() }),
  invalidateModelCache: () => {},
}));
const research = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/search/pipeline", () => ({
  clearSearchCaches: () => {},
  runResearch: async (opts: { question: string }) => {
    research.calls.push(opts.question);
    return { status: "done", queries: [opts.question], steps: [], sources: [], rag: [], limitations: [], error: null };
  },
}));

const chatRoute = await import("@/app/api/chat/route");
const routingRoute = await import("@/app/api/chat/routing/route");
const routingAdmin = await import("@/app/api/admin/routing/route");

// JEV : thinking très probable, research dans la zone grise, interactive improbable.
let probs: Record<string, number> = { thinking: 0.92, research: 0.7, interactive: 0.1 };
let fake: FakeJev;
beforeAll(async () => {
  fake = await startFakeJev({ noul: (name) => probs[name] ?? 0 });
});
afterAll(async () => {
  await fake.close();
});

let userId = "";
beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe('TRUNCATE "JevSettings", "RoutingSettings", "RoutingDecision"');
  await db.jevSettings.create({ data: { id: 1, host: "127.0.0.1", port: fake.port, timeoutMs: 2000 } });
  // Recherche Web configurée (SearXNG fictif ; le pipeline est simulé).
  await db.appSettings.create({ data: { id: 1, searxngUrl: "http://searxng.test:8080" } });
  invalidateJevSettings();
  probs = { thinking: 0.92, research: 0.7, interactive: 0.1 };
  fake.requests.length = 0;
  llm.requests = [];
  research.calls = [];
  const u = await createUser();
  userId = u.id;
  await loginAs(u.id);
  resetRateLimit(`routing:${u.id}`);
  resetRateLimit(`gen:${u.id}`);
});

async function propose(body: Record<string, unknown>) {
  const res = await routingRoute.POST(jsonRequest("POST", "/api/chat/routing", { model: "qwen3:32b", ...body }), {});
  return { status: res.status, body: await res.json() };
}

async function chat(body: Record<string, unknown>) {
  const res = await chatRoute.POST(jsonRequest("POST", "/api/chat", { action: "send", model: "qwen3:32b", thinking: false, ...body }), {});
  if (!res.ok || !res.body) return { status: res.status, events: [] as StreamEvent[], error: await res.json() };
  const text = await new Response(res.body).text();
  return { status: res.status, events: text.trim().split("\n").map((l) => JSON.parse(l) as StreamEvent) };
}

const startOf = (events: StreamEvent[]) => events.find((e) => e.type === "start") as Extract<StreamEvent, { type: "start" }>;

describe("Routage JEV de bout en bout", () => {
  it("hybride : thinking direct (92 %), recherche à confirmer (70 %) ; validation → modes appliqués et journalisés", async () => {
    const content = "Compare les offres d'électricité verte de cette année.";
    const p = await propose({ content });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ authMode: "HYBRID", needsConfirmation: true, jev: { consulted: true, ok: true } });
    expect(p.body.outcomes.thinking).toMatchObject({ state: "on", source: "jev" });
    expect(p.body.outcomes.research).toMatchObject({ state: "ask" });
    expect(p.body.outcomes.interactive).toMatchObject({ state: "off", source: "jev" });

    // Une seule requête JEV, avec les trois questions de routage.
    const calls = fake.requests.filter((r) => r.path === "/v1/systemone");
    expect(calls).toHaveLength(1);
    expect(Object.keys((calls[0].body as { questions: object }).questions)).toEqual(["thinking", "research", "interactive"]);
    expect((calls[0].body as { state: string }).state).toBe(content);

    // Sans réponse à la carte, Qwen n'est pas appelé.
    const refused = await chat({ content, routing: { decisionId: p.body.decisionId } });
    expect(refused.status).toBe(400);
    expect(llm.requests).toHaveLength(0);

    const r = await chat({ content, routing: { decisionId: p.body.decisionId, choice: "accept", accepted: ["research"] } });
    expect(r.status).toBe(200);
    const routingEvent = r.events.find((e) => e.type === "routing") as Extract<StreamEvent, { type: "routing" }>;
    expect(routingEvent.routing.outcomes.filter((o) => o.state === "on").map((o) => o.mode)).toEqual(["thinking", "research"]);
    expect(llm.requests[0].think).toBe(true);
    expect(research.calls).toEqual([content]);
    expect(r.events.find((e) => e.type === "research_start")).toMatchObject({ reason: "Recherche web : confirmé par vous (JEV 70 %)." });

    const start = startOf(r.events);
    const decision = await db.routingDecision.findUniqueOrThrow({ where: { id: p.body.decisionId } });
    expect(decision).toMatchObject({ status: "APPLIED", messageId: start.assistantMessageId, userChoice: "accept", finalModes: ["thinking", "research"], jevModel: "jevos-1b-q4_k_m" });
    expect(decision.probabilities).toEqual({ thinking: 0.92, research: 0.7, interactive: 0.1 });
    const msg = await db.message.findUniqueOrThrow({ where: { id: start.assistantMessageId } });
    expect((msg.routing as { outcomes: unknown[] }).outcomes).toHaveLength(3);

    // Une décision ne sert qu'une fois.
    const again = await chat({ content, conversationId: start.conversationId, routing: { decisionId: p.body.decisionId, choice: "accept", accepted: [] } });
    expect(again.status).toBe(409);
  });

  it("« Répondre sans ces modes » : aucun mode proposé n'est appliqué", async () => {
    const p = await propose({ content: "Question", authMode: "MANUAL" });
    const r = await chat({ content: "Question", routing: { decisionId: p.body.decisionId, choice: "reject" } });
    expect(llm.requests[0].think).toBe(false);
    expect(research.calls).toHaveLength(0);
    expect((await db.routingDecision.findUniqueOrThrow({ where: { id: p.body.decisionId } })).userChoice).toBe("reject");
    expect(r.status).toBe(200);
  });

  it("« Toujours accepter » : mémorisé pour la conversation, plus de carte ensuite", async () => {
    const p1 = await propose({ content: "Premier", authMode: "MANUAL" });
    const r1 = await chat({ content: "Premier", routing: { decisionId: p1.body.decisionId, choice: "always", accepted: ["thinking", "research"] } });
    const conversationId = startOf(r1.events).conversationId;
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).routingAutoAccept.sort()).toEqual(["research", "thinking"]);

    const p2 = await propose({ content: "Suite", authMode: "MANUAL", conversationId });
    expect(p2.body.needsConfirmation).toBe(false);
    expect(p2.body.outcomes.research).toMatchObject({ state: "on", source: "conversation" });
    // L'échange précédent accompagne la nouvelle demande.
    expect((fake.requests.at(-1)!.body as { state: string }).state).toMatch(/^Previous exchange \(context only\):\nUser: Premier\nAssistant: Réponse\./);
  });

  it("automatique : appliqué sans confirmation ; le choix de l'utilisateur prime", async () => {
    const p = await propose({ content: "Calcule 17 × 23", authMode: "AUTO", overrides: { research: "off" } });
    expect(p.body.needsConfirmation).toBe(false);
    expect(p.body.outcomes.research).toMatchObject({ state: "off", source: "user" });
    await chat({ content: "Calcule 17 × 23", routing: { decisionId: p.body.decisionId } });
    expect(llm.requests[0].think).toBe(true);
    expect(research.calls).toHaveLength(0);
  });

  it("désactivé : JEV n'est pas consulté, seuls les boutons comptent", async () => {
    const p = await propose({ content: "Bonjour", authMode: "OFF", overrides: { thinking: "on" } });
    expect(p.body.jev.consulted).toBe(false);
    expect(fake.requests.filter((r) => r.path === "/v1/systemone")).toHaveLength(0);
    await chat({ content: "Bonjour", routing: { decisionId: p.body.decisionId } });
    expect(llm.requests[0].think).toBe(true);
  });

  it("JEV injoignable : réponse simple, avis affiché, conversation jamais bloquée", async () => {
    await db.jevSettings.update({ where: { id: 1 }, data: { port: 1, timeoutMs: 500 } });
    invalidateJevSettings();
    const p = await propose({ content: "Quoi de neuf ?", authMode: "MANUAL" });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ needsConfirmation: false, jev: { consulted: true, ok: false } });
    const r = await chat({ content: "Quoi de neuf ?", routing: { decisionId: p.body.decisionId } });
    expect(r.events.find((e) => e.type === "notice" && e.code === "jev_unavailable")).toMatchObject({ message: expect.stringMatching(/réponse simple/) });
    expect(r.events.some((e) => e.type === "done")).toBe(true);
    expect(llm.requests[0].think).toBe(false);
    expect((await db.routingDecision.findUniqueOrThrow({ where: { id: p.body.decisionId } })).jevError).toBeTruthy();
  });

  it("modes interdits et seuils réglés dans l'administration", async () => {
    const admin = await createUser("ADMIN");
    await loginAs(admin.id);
    const get = await (await routingAdmin.GET(jsonRequest("GET", "/api/admin/routing"), {})).json();
    get.settings.modes.thinking.rule = "FORBIDDEN";
    get.settings.modes.research.threshold = 0.75;
    expect((await routingAdmin.PUT(jsonRequest("PUT", "/api/admin/routing", get.settings), {})).status).toBe(200);
    const p = await propose({ content: "x", authMode: "AUTO", overrides: { thinking: "on" } });
    expect(p.body.outcomes.thinking).toMatchObject({ state: "off", source: "admin" });
    expect(p.body.outcomes.research).toMatchObject({ state: "off", source: "jev" });
  });

  it("une décision n'est utilisable que par son auteur", async () => {
    const p = await propose({ content: "secret" });
    const other = await createUser();
    await loginAs(other.id);
    const r = await chat({ content: "secret", routing: { decisionId: p.body.decisionId, choice: "reject" } });
    expect(r.status).toBe(404);
    expect(userId).not.toBe(other.id);
  });

  it("sans routage, l'ancien fonctionnement reste inchangé", async () => {
    await chat({ content: "Bonjour", thinking: true });
    expect(llm.requests[0].think).toBe(true);
    expect(await db.routingDecision.count()).toBe(0);
  });
});
