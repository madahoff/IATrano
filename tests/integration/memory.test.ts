// Mémoire persistante et automatique, de bout en bout : vraies routes, vraie base PostgreSQL, fournisseur LLM factice.
// Les scénarios suivent les critères d'acceptation (1 à 12) ; le scénario 12 avec un vrai modèle est dans memory-real.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { GenerateRequest, LlmProvider, ModelInfo, ProviderChunk } from "@/lib/llm/types";
import type { StreamEvent } from "@/lib/chat/protocol";
import type { ContextUsageDTO } from "@/lib/context/types";
import { MEMORY_HEADER, PROJECT_MEMORY_HEADER } from "@/lib/context/assemble";
import { memoryBudget } from "@/lib/memory/select";
import { MAX_ATTEMPTS, processMemoryJob, runDueMemoryJobs } from "@/lib/memory/jobs";
import { consolidateMemories } from "@/lib/memory/consolidate";
import { createUser, jsonRequest, loginAs, params, resetDb } from "../support/fixtures";

const state: {
  requests: GenerateRequest[];
  jsonCalls: GenerateRequest[];
  json: (req: GenerateRequest) => Promise<string>;
} = { requests: [], jsonCalls: [], json: async () => '{"actions":[]}' };

const fakeProvider: LlmProvider = {
  kind: "OLLAMA",
  label: "Fake",
  testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://fake", latencyMs: 1 }),
  listModels: async () => models,
  chatStream: async function* (req): AsyncGenerator<ProviderChunk> {
    state.requests.push(req);
    yield { type: "text", delta: "Réponse de test." };
    yield { type: "done", reason: "stop", evalCount: 4 };
  },
  complete: async () => "Titre",
  completeJson: async (req) => {
    state.jsonCalls.push(req);
    return state.json(req);
  },
};

const models: ModelInfo[] = [{ id: "qwen:3b", name: "qwen:3b", provider: "OLLAMA", contextLength: 32768, capabilities: { thinking: "no", tools: "no", vision: "no" } }];

vi.mock("@/lib/llm/registry", () => ({
  createProvider: () => fakeProvider,
  buildProvider: () => fakeProvider,
  PROVIDER_LABELS: { OLLAMA: "Ollama", OPENAI_COMPATIBLE: "OpenAI" },
}));
vi.mock("@/lib/llm/discovery", () => ({
  getModels: async () => ({ provider: { kind: "OLLAMA", reachable: true }, models, fetchedAt: new Date().toISOString() }),
  invalidateModelCache: () => {},
}));

let chatRoute = await import("@/app/api/chat/route");
const memoriesRoute = await import("@/app/api/memories/route");
const memoryRoute = await import("@/app/api/memories/[id]/route");
const memorySettingsRoute = await import("@/app/api/memories/settings/route");
const jobsRoute = await import("@/app/api/memories/jobs/route");
const projectMemoriesRoute = await import("@/app/api/projects/[id]/memories/route");
const contextRoute = await import("@/app/api/context/route");

async function chat(body: Record<string, unknown>) {
  const res = await chatRoute.POST(jsonRequest("POST", "/api/chat", { webSearch: false, model: "qwen:3b", thinking: false, action: "send", ...body }), {});
  const events: StreamEvent[] = [];
  for (const line of (await res.text()).split("\n")) if (line.trim()) events.push(JSON.parse(line));
  return events;
}
const lastSystem = () => state.requests.at(-1)!.messages[0].content;
const memoryEvent = (events: StreamEvent[]) => events.find((e) => e.type === "memory") as Extract<StreamEvent, { type: "memory" }> | undefined;
const active = (userId: string) => db.memory.findMany({ where: { userId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
const list = async () => (await (await memoriesRoute.GET(jsonRequest("GET", "/api/memories"), {})).json()) as { memories: Array<{ id: string; content: string }>; jobs: { pending: number; failed: number } };

/** Réponse du modèle factice pour l'extraction, avec la preuve exigée. */
const llmActions = (actions: unknown[]) => async () => JSON.stringify({ actions });

let userId = "";
beforeEach(async () => {
  await resetDb();
  userId = (await createUser()).id;
  await loginAs(userId);
  state.requests = [];
  state.jsonCalls = [];
  state.json = async () => '{"actions":[]}';
});

describe("1–3 · mémorisation automatique, persistance, nouvelle conversation", () => {
  it("1 · une préférence exprimée est mémorisée sans demande explicite (règle, sans appel au modèle)", async () => {
    const events = await chat({ content: "Pour mes projets JavaScript, je préfère utiliser pnpm plutôt que npm." });
    expect(events.find((e) => e.type === "done")).toMatchObject({ status: "COMPLETE" });
    expect(memoryEvent(events)?.saved).toEqual(["L'utilisateur préfère pnpm plutôt que npm."]);
    expect(state.jsonCalls).toHaveLength(0);
    const [m] = await active(userId);
    expect(m).toMatchObject({ kind: "PREFERENCE", source: "AUTO", certainty: "STATED", topic: "gestionnaire-paquets", projectId: null });
    expect(await db.memoryJob.findFirst({ where: { userId } })).toMatchObject({ status: "DONE", attempts: 1 });
  });

  it("1 bis · une information durable plus riche passe par le modèle, avec preuve", async () => {
    state.json = llmActions([
      { action: "add", scope: "personal", kind: "FACT", topic: "metier", content: "L'utilisateur est développeur full-stack chez Acme.", evidence: "je suis développeur full-stack chez Acme", importance: 3 },
      { action: "add", scope: "personal", kind: "FACT", content: "L'utilisateur a 10 ans d'expérience.", evidence: "", importance: 3 },
    ]);
    const events = await chat({ content: "Je suis développeur full-stack chez Acme. Comment structurer un monorepo ?" });
    expect(state.jsonCalls).toHaveLength(1);
    // La réponse du modèle de conversation n'est pas transmise à l'extraction : seul le message de l'utilisateur l'est.
    expect(state.jsonCalls[0].messages[1].content).not.toContain("Réponse de test.");
    expect(memoryEvent(events)?.saved).toEqual(["L'utilisateur est développeur full-stack chez Acme."]);
    expect(await active(userId)).toHaveLength(1);
  });

  it("2–3 · la préférence survit à un redémarrage et sert dans une nouvelle conversation", async () => {
    await chat({ content: "Je préfère utiliser pnpm plutôt que npm." });
    // Redémarrage simulé : nouveau client Prisma, modules rechargés (aucun état en mémoire du processus).
    await db.$disconnect();
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.resetModules();
    chatRoute = await import("@/app/api/chat/route");
    const fresh = (await import("@/lib/db")).db;
    expect(fresh).not.toBe(db);
    state.requests = [];
    const events = await chat({ content: "Comment installer les dépendances de mon projet Vite ?" });
    const start = events.find((e) => e.type === "start") as Extract<StreamEvent, { type: "start" }>;
    expect(await fresh.conversation.count({ where: { userId } })).toBe(2);
    expect(start.conversationId).toBeTruthy();
    expect(lastSystem()).toContain(MEMORY_HEADER);
    expect(lastSystem()).toContain("pnpm plutôt que npm");
    expect(await fresh.memory.count({ where: { userId } })).toBe(1);
  });

  it("le renforcement : une préférence répétée n'est pas dupliquée et devient confirmée", async () => {
    await chat({ content: "Je préfère utiliser pnpm plutôt que npm." });
    await chat({ content: "Comme d'habitude, je préfère pnpm plutôt que npm." });
    await chat({ content: "Rappel : je préfère pnpm plutôt que npm." });
    const all = await active(userId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ mentionCount: 3, certainty: "CONFIRMED" });
  });
});

describe("4 · isolation stricte entre utilisateurs", () => {
  it("un autre compte ne voit, ne modifie, ne supprime ni ne reçoit jamais cette mémoire", async () => {
    await chat({ content: "Je préfère utiliser pnpm plutôt que npm." });
    const [m] = await active(userId);
    const other = await createUser();
    await loginAs(other.id);
    expect((await list()).memories).toHaveLength(0);
    expect((await memoryRoute.PATCH(jsonRequest("PATCH", `/api/memories/${m.id}`, { content: "piraté" }), params({ id: m.id }))).status).toBe(404);
    expect((await memoryRoute.DELETE(jsonRequest("DELETE", `/api/memories/${m.id}`), params({ id: m.id }))).status).toBe(404);
    expect((await (await memoriesRoute.DELETE(jsonRequest("DELETE", "/api/memories", { confirm: true }), {})).json()).deleted).toBe(0);
    await chat({ content: "Comment installer les dépendances ?" });
    expect(lastSystem()).not.toContain("pnpm");
    await loginAs(userId);
    expect((await list()).memories.map((x) => x.content)).toEqual(["L'utilisateur préfère pnpm plutôt que npm."]);
  });
});

describe("5 · informations ponctuelles", () => {
  it("une question ou une information du jour ne déclenche ni analyse ni mémorisation", async () => {
    await chat({ content: "Quelle heure est-il à Tokyo ?" });
    await chat({ content: "Je suis fatigué aujourd'hui, explique-moi simplement les closures." });
    expect(state.jsonCalls).toHaveLength(0);
    expect(await db.memoryJob.count({ where: { userId } })).toBe(0);
    expect(await db.memory.count({ where: { userId } })).toBe(0);
  });

  it("une information datée proposée par le modèle est écartée sans notification", async () => {
    state.json = llmActions([{ action: "add", scope: "personal", kind: "FACT", content: "L'utilisateur travaille sur un bug CSS.", evidence: "ce soir je travaille sur un bug CSS", importance: 3 }]);
    const events = await chat({ content: "Ce soir je travaille sur un bug CSS : pourquoi mon flex ne s'aligne pas ?" });
    expect(state.jsonCalls).toHaveLength(1);
    expect(memoryEvent(events)).toBeUndefined();
    expect(await db.memory.count({ where: { userId } })).toBe(0);
  });
});

describe("6 · préférence modifiée", () => {
  it("la nouvelle préférence remplace l'ancienne, conservée comme historique et jamais injectée", async () => {
    await chat({ content: "Je préfère utiliser npm plutôt que pnpm." });
    const events = await chat({ content: "Finalement je préfère utiliser pnpm plutôt que npm." });
    expect(memoryEvent(events)?.updated).toEqual(["L'utilisateur préfère pnpm plutôt que npm."]);
    const all = await db.memory.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    expect(all.map((m) => m.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
    expect(all[0].supersededById).toBe(all[1].id);
    await chat({ content: "Quelle commande pour installer les dépendances ?" });
    expect(lastSystem()).toContain("pnpm plutôt que npm");
    expect(lastSystem()).not.toContain("npm plutôt que pnpm");
  });

  it("une correction désignée par le modèle met à jour le souvenir existant", async () => {
    await (await memoriesRoute.POST(jsonRequest("POST", "/api/memories", { kind: "FACT", content: "L'utilisateur utilise MySQL." }), {})).json();
    state.json = async (req) => {
      expect(req.messages[1].content).toMatch(/M1 \[personnel · FACT\] L'utilisateur utilise MySQL\./);
      return JSON.stringify({ actions: [{ action: "update", ref: "M1", scope: "personal", kind: "FACT", topic: "base-de-donnees", content: "L'utilisateur utilise PostgreSQL.", evidence: "j'utilise PostgreSQL, pas MySQL", importance: 3 }] });
    };
    const events = await chat({ content: "En fait j'utilise PostgreSQL, pas MySQL. Comment créer un index ?" });
    expect(memoryEvent(events)?.updated).toEqual(["L'utilisateur utilise PostgreSQL."]);
    expect((await active(userId)).map((m) => m.content)).toEqual(["L'utilisateur utilise PostgreSQL."]);
  });
});

describe("7 · mémoire propre à un projet", () => {
  it("les décisions d'un projet restent dans ce projet", async () => {
    const atlas = await db.project.create({ data: { userId, name: "Atlas" } });
    const borea = await db.project.create({ data: { userId, name: "Borea" } });
    state.json = llmActions([
      { action: "add", scope: "project", kind: "DECISION", topic: "api", content: "Le projet expose son API avec tRPC.", evidence: "on a décidé d'exposer l'API avec tRPC", importance: 4 },
      { action: "add", scope: "personal", kind: "PREFERENCE", content: "L'utilisateur veut des exemples en TypeScript.", evidence: "je veux toujours des exemples en TypeScript", importance: 4 },
    ]);
    const events = await chat({ content: "Sur ce projet on a décidé d'exposer l'API avec tRPC. Et je veux toujours des exemples en TypeScript.", projectId: atlas.id });
    expect(memoryEvent(events)?.saved).toHaveLength(2);
    expect(state.jsonCalls[0].messages[0].content).toContain("« Atlas »");
    const all = await active(userId);
    expect(all.find((m) => m.content.includes("tRPC"))?.projectId).toBe(atlas.id);
    expect(all.find((m) => m.content.includes("TypeScript"))?.projectId).toBeNull();

    await chat({ content: "Comment exposer l'API de ce service ?", projectId: borea.id });
    expect(lastSystem()).not.toContain("tRPC");
    expect(lastSystem()).toContain("TypeScript");
    await chat({ content: "Comment exposer l'API de ce service ?" });
    expect(lastSystem()).not.toContain("tRPC");
    await chat({ content: "Comment exposer l'API de ce service ?", projectId: atlas.id });
    expect(lastSystem()).toContain(PROJECT_MEMORY_HEADER("Atlas"));
    expect(lastSystem()).toContain("tRPC");

    // Gestion depuis le projet : la route ne liste que ce projet.
    const res = await projectMemoriesRoute.GET(jsonRequest("GET", `/api/projects/${borea.id}/memories`), params({ id: borea.id }));
    expect((await res.json()).memories).toHaveLength(0);
  });

  it("projet dont la mémoire est désactivée : rien n'y est écrit ni injecté", async () => {
    const off = await db.project.create({ data: { userId, name: "Off", memoryEnabled: false } });
    await db.memory.create({ data: { userId, projectId: off.id, kind: "DECISION", content: "Le projet utilise Redis pour les files.", importance: 5 } });
    state.json = llmActions([{ action: "add", scope: "project", kind: "DECISION", content: "Le projet utilise Kafka.", evidence: "on a choisi Kafka", importance: 4 }]);
    await chat({ content: "Pour ce projet on a choisi Kafka.", projectId: off.id });
    expect(lastSystem()).not.toContain("Redis");
    expect(await db.memory.count({ where: { userId, projectId: off.id } })).toBe(1);
  });
});

describe("8 · oubli", () => {
  it("« oublie que… » supprime réellement le souvenir et son historique", async () => {
    await chat({ content: "Je préfère utiliser npm plutôt que pnpm." });
    await chat({ content: "Je préfère utiliser pnpm plutôt que npm." });
    expect(await db.memory.count({ where: { userId } })).toBe(2);
    const events = await chat({ content: "Oublie que je préfère pnpm." });
    expect(memoryEvent(events)?.removed).toBe(1);
    expect(await db.memory.count({ where: { userId } })).toBe(0);
    expect(await db.memoryTombstone.count({ where: { userId } })).toBe(1);
    await chat({ content: "Comment installer les dépendances ?" });
    expect(lastSystem()).not.toContain("pnpm");
  });

  it("suppression depuis l'interface : une analyse encore en attente ne recrée pas le souvenir", async () => {
    // Le message est analysé plus tard (modèle indisponible au moment de la réponse).
    state.json = async () => {
      throw new Error("modèle indisponible");
    };
    const conv = await chat({ content: "Je travaille chez Acme comme développeur." });
    const job = await db.memoryJob.findFirstOrThrow({ where: { userId } });
    expect(job.status).toBe("PENDING");
    // Entre-temps, l'utilisateur ajoute puis supprime ce souvenir.
    const { memory } = await (await memoriesRoute.POST(jsonRequest("POST", "/api/memories", { kind: "FACT", content: "L'utilisateur travaille chez Acme comme développeur." }), {})).json();
    expect((await memoryRoute.DELETE(jsonRequest("DELETE", `/api/memories/${memory.id}`), params({ id: memory.id }))).status).toBe(200);
    state.json = llmActions([{ action: "add", scope: "personal", kind: "FACT", content: "L'utilisateur travaille chez Acme comme développeur.", evidence: "Je travaille chez Acme comme développeur", importance: 3 }]);
    await db.memoryJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date() } });
    expect(await runDueMemoryJobs()).toBe(1);
    expect(conv.length).toBeGreaterThan(0);
    expect(await db.memory.count({ where: { userId } })).toBe(0);
  });

  it("effacer toute la mémoire abandonne aussi les analyses en attente", async () => {
    state.json = async () => {
      throw new Error("indisponible");
    };
    await chat({ content: "Je travaille chez Acme comme développeur." });
    await memoriesRoute.DELETE(jsonRequest("DELETE", "/api/memories", { confirm: true }), {});
    expect(await db.memoryJob.findFirst({ where: { userId } })).toMatchObject({ status: "SKIPPED" });
  });
});

describe("9 · secrets et données d'authentification", () => {
  it("jamais mémorisés, même sur demande, et jamais transmis à l'extraction", async () => {
    const events = await chat({ content: "Retiens que mon mot de passe est hunter2-Zx9." });
    expect(state.jsonCalls).toHaveLength(0);
    expect(memoryEvent(events)?.rejected.length).toBe(1);
    await chat({ content: "Retiens que ma clé API est sk-proj-abcdefghijklmnopqrstuvwxyz123456." });
    expect(state.jsonCalls).toHaveLength(0);
    expect(await db.memory.count({ where: { userId } })).toBe(0);
  });

  it("un secret glissé par le modèle dans une proposition est refusé", async () => {
    state.json = llmActions([{ action: "add", scope: "personal", kind: "FACT", content: "Le token d'accès de l'utilisateur est stocké dans Vault.", evidence: "je stocke mon token d'accès dans Vault", importance: 3 }]);
    await chat({ content: "Je stocke mon token d'accès dans Vault, je travaille avec HashiCorp." });
    expect(await db.memory.count({ where: { userId } })).toBe(0);
  });
});

describe("10 · budget de contexte", () => {
  it("une mémoire volumineuse ne dépasse pas le budget réservé", async () => {
    await db.memory.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({ userId, kind: i % 2 ? ("PREFERENCE" as const) : ("FACT" as const), content: `L'utilisateur applique la règle de nommage numéro ${i} pour ses fichiers TypeScript et ses composants React.`, importance: 3 })),
    });
    await chat({ content: "Comment nommer mes fichiers TypeScript et composants React ?" });
    const res = await contextRoute.GET(jsonRequest("GET", `/api/context?model=qwen:3b`), {});
    const usage = (await res.json()).usage as ContextUsageDTO;
    expect(usage.memory.injected.length).toBeGreaterThan(0);
    expect(usage.memory.injected.length).toBeLessThan(200);
    // Budget des souvenirs + en-têtes et consigne de mémoire.
    expect(usage.parts.memory).toBeLessThanOrEqual(memoryBudget(usage.capacity) + 250);
  });
});

describe("11 · panne de l'extraction", () => {
  it("ne bloque pas la conversation et ne perd pas l'opération : reprise ultérieure", async () => {
    state.json = async () => {
      throw new Error("Ollama injoignable");
    };
    const events = await chat({ content: "Je travaille chez Acme comme développeuse backend." });
    expect(events.find((e) => e.type === "done")).toMatchObject({ status: "COMPLETE" });
    expect(events.some((e) => e.type === "error")).toBe(false);
    const job = await db.memoryJob.findFirstOrThrow({ where: { userId } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1, error: expect.stringContaining("Ollama injoignable") });
    expect((await list()).jobs.pending).toBe(1);

    // Le modèle revient : la tâche de fond reprend l'analyse.
    state.json = llmActions([{ action: "add", scope: "personal", kind: "FACT", content: "L'utilisateur est développeuse backend chez Acme.", evidence: "Je travaille chez Acme comme développeuse backend", importance: 3 }]);
    await db.memoryJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date() } });
    expect(await runDueMemoryJobs()).toBe(1);
    expect(await db.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "DONE", attempts: 2 });
    expect((await active(userId)).map((m) => m.content)).toEqual(["L'utilisateur est développeuse backend chez Acme."]);
  });

  it("une tâche interrompue par un redémarrage est reprise", async () => {
    state.json = async () => {
      throw new Error("indisponible");
    };
    await chat({ content: "Je travaille chez Acme comme développeur." });
    const job = await db.memoryJob.findFirstOrThrow({ where: { userId } });
    await db.memoryJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedAt: new Date(Date.now() - 10 * 60_000) } });
    state.json = llmActions([{ action: "add", scope: "personal", kind: "FACT", content: "L'utilisateur travaille chez Acme.", evidence: "Je travaille chez Acme", importance: 3 }]);
    expect(await runDueMemoryJobs()).toBe(1);
    expect(await db.memory.count({ where: { userId } })).toBe(1);
  });

  it("après plusieurs échecs, une demande explicite est conservée sans le modèle ; l'échec est visible", async () => {
    state.json = async () => {
      throw new Error("indisponible");
    };
    await chat({ content: "Retiens que je livre toujours le vendredi." });
    const job = await db.memoryJob.findFirstOrThrow({ where: { userId } });
    await db.memoryJob.update({ where: { id: job.id }, data: { attempts: MAX_ATTEMPTS - 1, status: "PENDING" } });
    await processMemoryJob(job.id);
    expect(await db.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "DONE", error: expect.stringContaining("indisponible") });
    expect((await active(userId)).map((m) => [m.content, m.certainty])).toEqual([["L'utilisateur livre toujours le vendredi.", "CONFIRMED"]]);

    // Échec définitif (base, etc.) : relançable depuis l'interface.
    await db.memoryJob.update({ where: { id: job.id }, data: { status: "FAILED" } });
    expect((await list()).jobs.failed).toBe(1);
    const retry = await (await jobsRoute.POST(jsonRequest("POST", "/api/memories/jobs", { action: "retry" }), {})).json();
    expect(retry.retried).toBe(1);
  });
});

describe("réglages et contrôle", () => {
  it("enregistrement automatique désactivé : seules les demandes explicites sont prises en compte", async () => {
    await memorySettingsRoute.PATCH(jsonRequest("PATCH", "/api/memories/settings", { memoryAutoSave: false }), {});
    await chat({ content: "Je préfère utiliser pnpm plutôt que npm." });
    expect(await db.memory.count({ where: { userId } })).toBe(0);
    await chat({ content: "Retiens que je préfère utiliser pnpm plutôt que npm." });
    expect((await active(userId))[0]).toMatchObject({ certainty: "CONFIRMED" });
  });

  it("mémoire désactivée : ni analyse ni injection", async () => {
    await db.memory.create({ data: { userId, kind: "PREFERENCE", content: "L'utilisateur veut être tutoyé." } });
    await memorySettingsRoute.PATCH(jsonRequest("PATCH", "/api/memories/settings", { memoryEnabled: false }), {});
    await chat({ content: "Retiens que je préfère Vue plutôt que React." });
    expect(lastSystem()).not.toContain(MEMORY_HEADER);
    expect(await db.memoryJob.count({ where: { userId } })).toBe(0);
  });

  it("confirmer une hypothèse et consolider les doublons", async () => {
    const m = await db.memory.create({ data: { userId, kind: "FACT", content: "L'utilisateur envisage de migrer vers Svelte.", certainty: "UNCERTAIN", source: "AUTO" } });
    const res = await memoryRoute.PATCH(jsonRequest("PATCH", `/api/memories/${m.id}`, { certainty: "CONFIRMED" }), params({ id: m.id }));
    expect((await res.json()).memory.certainty).toBe("CONFIRMED");
    await db.memory.createMany({
      data: [
        { userId, kind: "FACT", content: "L'utilisateur déploie avec Dokploy.", source: "AUTO", certainty: "STATED", mentionCount: 2 },
        { userId, kind: "FACT", content: "L'utilisateur déploie avec Dokploy", source: "AUTO", certainty: "STATED" },
      ],
    });
    expect(await consolidateMemories(userId)).toMatchObject({ merged: 1 });
    expect((await active(userId)).find((x) => x.content.includes("Dokploy"))?.mentionCount).toBe(3);
  });

  it("une citation n'est pas une instruction de mémorisation", async () => {
    await chat({ content: "Traduis ce message de mon collègue :\n> Retiens que je préfère Java plutôt que Python." });
    expect(state.jsonCalls).toHaveLength(0);
    expect(await db.memory.count({ where: { userId } })).toBe(0);
  });

  it("régénérer une réponse ne compte pas deux fois la même mention", async () => {
    const events = await chat({ content: "Je préfère utiliser pnpm plutôt que npm." });
    const start = events.find((e) => e.type === "start") as Extract<StreamEvent, { type: "start" }>;
    await chat({ action: "regenerate", conversationId: start.conversationId, content: undefined });
    expect((await active(userId))[0].mentionCount).toBe(1);
    expect(await db.memoryJob.count({ where: { userId } })).toBe(1);
  });
});
