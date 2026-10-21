// Orchestration de la génération avec un fournisseur factice (mock isolé) et une vraie base.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { ProviderError, type GenerateRequest, type LlmProvider, type ModelInfo, type ProviderChunk } from "@/lib/llm/types";
import type { StreamEvent } from "@/lib/chat/protocol";
import { createUser, jsonRequest, loginAs, resetDb } from "../support/fixtures";

type Script = (req: GenerateRequest) => AsyncGenerator<ProviderChunk>;
const state: { script: Script; requests: GenerateRequest[]; json: string; models: ModelInfo[]; reachable: boolean } = {
  script: async function* () {},
  requests: [],
  json: "{}",
  models: [],
  reachable: true,
};

const fakeProvider: LlmProvider = {
  kind: "OLLAMA",
  label: "Fake",
  testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://fake", latencyMs: 1 }),
  listModels: async () => state.models,
  chatStream: (req) => {
    state.requests.push(req);
    return state.script(req);
  },
  complete: async () => "Titre de test",
  completeJson: async () => state.json,
};

vi.mock("@/lib/llm/registry", () => ({
  createProvider: () => fakeProvider,
  buildProvider: () => fakeProvider,
  PROVIDER_LABELS: { OLLAMA: "Ollama", OPENAI_COMPATIBLE: "OpenAI" },
}));
vi.mock("@/lib/llm/discovery", () => ({
  getModels: async () => ({
    provider: state.reachable ? { kind: "OLLAMA", reachable: true } : { kind: "OLLAMA", reachable: false, error: "Connexion refusée par localhost:11434.", hint: "Démarrez Ollama." },
    models: state.reachable ? state.models : [],
    fetchedAt: new Date().toISOString(),
  }),
  invalidateModelCache: () => {},
}));

const { POST } = await import("@/app/api/chat/route");

const model = (id: string, thinking: "yes" | "no" | "unknown"): ModelInfo => ({ id, name: id, provider: "OLLAMA", capabilities: { thinking, tools: "no", vision: "no" } });

async function chat(body: Record<string, unknown>, opts: { abortAfterEvents?: number } = {}) {
  const ctrl = new AbortController();
  const req = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  });
  const res = await POST(req, {});
  if (!res.ok || !res.body) return { status: res.status, events: [] as StreamEvent[] };
  const events: StreamEvent[] = [];
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      events.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      if (opts.abortAfterEvents && events.length === opts.abortAfterEvents) ctrl.abort();
    }
  }
  return { status: res.status, events };
}

const textOf = (events: StreamEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");

let userId = "";
beforeEach(async () => {
  await resetDb();
  const u = await createUser();
  userId = u.id;
  await loginAs(u.id);
  state.requests = [];
  state.reachable = true;
  state.models = [model("think:1b", "yes"), model("plain:3b", "no")];
  state.json = "{}";
});

describe("Génération en streaming", () => {
  it("sépare raisonnement, réponse et clarification, puis persiste le tout", async () => {
    state.script = async function* () {
      yield { type: "thinking", delta: "Je dois " };
      yield { type: "thinking", delta: "demander la plateforme." };
      yield { type: "text", delta: "Il me manque une info.<clar" };
      yield { type: "text", delta: 'ify>{"questions":[{"question":"Quelle plateforme ?","options":["Web","Mobile"]}]}</clarify>' };
      yield { type: "done", reason: "stop" };
    };
    const { status, events } = await chat({ action: "send", content: "Conçois une application", model: "think:1b", thinking: true });
    expect(status).toBe(200);
    expect(events[0]).toMatchObject({ type: "start", thinking: true });
    expect(textOf(events)).toBe("Il me manque une info.");
    expect(events.find((e) => e.type === "clarification")).toMatchObject({ data: { questions: [{ question: "Quelle plateforme ?" }] } });
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "title", title: "Titre de test" });
    expect(state.requests[0].think).toBe(true);

    const start = events[0] as Extract<StreamEvent, { type: "start" }>;
    const msg = await db.message.findUniqueOrThrow({ where: { id: start.assistantMessageId } });
    expect(msg).toMatchObject({ status: "COMPLETE", content: "Il me manque une info.", thinking: "Je dois demander la plateforme.", thinkingEnabled: true, model: "think:1b" });
    expect(msg.clarification).toEqual({ questions: [{ question: "Quelle plateforme ?", options: ["Web", "Mobile"] }] });
    expect(await db.conversation.findUniqueOrThrow({ where: { id: start.conversationId } })).toMatchObject({ userId, model: "think:1b", title: "Titre de test" });
  });

  it("n'active pas le Thinking sur un modèle qui ne le prend pas en charge, et le signale", async () => {
    state.script = async function* () {
      yield { type: "text", delta: "Tokyo." };
    };
    const { events } = await chat({ action: "send", content: "Capitale du Japon ?", model: "plain:3b", thinking: true });
    expect(events[0]).toMatchObject({ type: "start", thinking: false });
    expect(events.find((e) => e.type === "notice")).toMatchObject({ code: "thinking_unsupported" });
    expect(state.requests[0].think).toBeUndefined();
  });

  it("indique quand un modèle à Thinking ne renvoie aucun raisonnement distinct", async () => {
    state.script = async function* () {
      yield { type: "text", delta: "Réponse directe." };
    };
    const { events } = await chat({ action: "send", content: "x", model: "think:1b", thinking: true });
    expect(events.find((e) => e.type === "notice")).toMatchObject({ code: "thinking_not_returned" });
  });

  it("un JSON de clarification invalide n'empêche pas la réponse", async () => {
    state.script = async function* () {
      yield { type: "text", delta: 'Réponse.<clarify>{"questions": [ {"quest' };
    };
    const { events } = await chat({ action: "send", content: "x", model: "plain:3b", thinking: false });
    expect(textOf(events)).toBe("Réponse.");
    expect(events.find((e) => e.type === "notice")).toMatchObject({ code: "clarification_invalid" });
    expect(events.find((e) => e.type === "done")).toMatchObject({ status: "COMPLETE" });
  });

  it("repli structuré quand le modèle pose ses questions en texte", async () => {
    state.script = async function* () {
      yield { type: "text", delta: "Pour vous aider :\n1. Quel langage ?\n2. Quel but ?" };
    };
    state.json = '{"questions":[{"question":"Quel langage ?","options":["Python","Go"]},{"question":"Quel but ?","options":["Automatiser","Analyser"]}]}';
    const { events } = await chat({ action: "send", content: "Écris un script", model: "plain:3b", thinking: false });
    expect(events.find((e) => e.type === "clarification")).toMatchObject({ data: { questions: [{ options: ["Python", "Go"] }, { question: "Quel but ?" }] } });
  });

  it("annulation : la partie générée est conservée et marquée CANCELLED", async () => {
    state.script = async function* (req) {
      yield { type: "text", delta: "Début de réponse" };
      await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new ProviderError("Génération annulée.", "aborted");
    };
    const { events } = await chat({ action: "send", content: "Raconte une longue histoire", model: "plain:3b", thinking: false }, { abortAfterEvents: 3 }); // start, context, text
    const start = events[0] as Extract<StreamEvent, { type: "start" }>;
    await vi.waitFor(async () => {
      const msg = await db.message.findUniqueOrThrow({ where: { id: start.assistantMessageId } });
      expect(msg.status).toBe("CANCELLED");
      expect(msg.content).toBe("Début de réponse");
    });
  });

  it("erreur du fournisseur en cours de flux : message d'erreur clair et historique intact", async () => {
    state.script = async function* () {
      yield { type: "text", delta: "Partiel" };
      throw new ProviderError("Erreur Ollama : out of memory", "http_error");
    };
    const { events } = await chat({ action: "send", content: "x", model: "plain:3b", thinking: false });
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Erreur Ollama : out of memory" });
    const start = events[0] as Extract<StreamEvent, { type: "start" }>;
    const msgs = await db.message.findMany({ where: { conversationId: start.conversationId }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => [m.role, m.status, m.content])).toEqual([
      ["USER", "COMPLETE", "x"],
      ["ASSISTANT", "ERROR", "Partiel"],
    ]);
    expect(await db.errorLog.count({ where: { source: "chat", level: "ERROR" } })).toBe(1);
  });

  it("modèle indisponible ou serveur injoignable : erreur explicite sans appel au fournisseur", async () => {
    const missing = await chat({ action: "send", content: "x", model: "absent:7b", thinking: false });
    expect(missing.events.find((e) => e.type === "error")).toMatchObject({ code: "model_not_found" });
    state.reachable = false;
    const down = await chat({ action: "send", content: "x", model: "plain:3b", thinking: false });
    expect(down.events.find((e) => e.type === "error")).toMatchObject({ code: "unreachable", hint: "Démarrez Ollama." });
    expect(state.requests).toHaveLength(0);
  });

  it("réponse vide : signalée comme erreur", async () => {
    state.script = async function* () {
      yield { type: "done" };
    };
    const { events } = await chat({ action: "send", content: "x", model: "plain:3b", thinking: false });
    expect(events.find((e) => e.type === "notice")).toMatchObject({ code: "empty_response" });
    const start = events[0] as Extract<StreamEvent, { type: "start" }>;
    expect((await db.message.findUniqueOrThrow({ where: { id: start.assistantMessageId } })).status).toBe("ERROR");
  });

  it("édition d'un ancien message : les réponses suivantes sont remplacées", async () => {
    let n = 0;
    state.script = async function* () {
      n++;
      yield { type: "text", delta: `Réponse ${n}` };
    };
    const first = await chat({ action: "send", content: "Question 1", model: "plain:3b", thinking: false });
    const convId = (first.events[0] as Extract<StreamEvent, { type: "start" }>).conversationId;
    await chat({ action: "send", conversationId: convId, content: "Question 2", model: "plain:3b", thinking: false });
    const q1 = await db.message.findFirstOrThrow({ where: { conversationId: convId, content: "Question 1" } });

    await chat({ action: "edit", conversationId: convId, messageId: q1.id, content: "Question 1 bis", model: "plain:3b", thinking: false });
    const msgs = await db.message.findMany({ where: { conversationId: convId }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => m.content)).toEqual(["Question 1 bis", "Réponse 3"]);
    expect(state.requests.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "Question 1 bis" });

    await chat({ action: "regenerate", conversationId: convId, model: "plain:3b", thinking: false });
    const regen = await db.message.findMany({ where: { conversationId: convId }, orderBy: { createdAt: "asc" } });
    expect(regen.map((m) => m.content)).toEqual(["Question 1 bis", "Réponse 4"]);
  });

  it("refuse un message vide et applique la limite de débit", async () => {
    expect((await chat({ action: "send", content: "   ", model: "plain:3b" })).status).toBe(400);
    state.script = async function* () {
      yield { type: "text", delta: "ok" };
    };
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await chat({ action: "send", content: `m${i}`, model: "plain:3b" })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

void jsonRequest;
