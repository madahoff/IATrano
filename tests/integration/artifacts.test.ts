// Mode interactif de bout en bout : routage (JEV simulé), génération en streaming, versions, modification, correction.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { GenerateRequest, LlmProvider, ModelInfo, ProviderChunk } from "@/lib/llm/types";
import type { StreamEvent } from "@/lib/chat/protocol";
import type { ArtifactDTO } from "@/lib/artifacts/types";
import { createUser, jsonRequest, loginAs, params, resetDb } from "../support/fixtures";
import { startFakeJev, type FakeJev } from "../support/fake-jev";
import { invalidateJevSettings } from "@/lib/jev/settings";
import { resetRateLimit } from "@/lib/rate-limit";

const PAGE_V1 = `<!doctype html><html lang="fr"><body><h1>Intérêts composés</h1><input id="taux" aria-label="Taux"><script>document.getElementById("taux").value = 3;</script></body></html>`;
const PAGE_V2 = PAGE_V1.replace("<h1>", '<h1 style="font-size:3rem">');
const PAGE_FIXED = PAGE_V2.replace("getElementById", "querySelector").replace('"taux"', '"#taux"');

const llm: { requests: GenerateRequest[]; reply: string; complete: string; completeRequests: GenerateRequest[] } = { requests: [], reply: "", complete: "", completeRequests: [] };
const fakeProvider: LlmProvider = {
  kind: "OLLAMA",
  label: "Fake",
  testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://fake", latencyMs: 1 }),
  listModels: async () => models,
  chatStream: (req) => {
    llm.requests.push(req);
    const reply = llm.reply;
    return (async function* (): AsyncGenerator<ProviderChunk> {
      // Découpage irrégulier : les balises <artifact> arrivent coupées entre plusieurs fragments.
      for (let i = 0; i < reply.length; i += 11) yield { type: "text", delta: reply.slice(i, i + 11) };
      yield { type: "done", reason: "stop" };
    })();
  },
  complete: async (req) => {
    llm.completeRequests.push(req);
    return req.messages.some((m) => m.content.includes("<current_artifact")) ? llm.complete : "Titre";
  },
  completeJson: async () => "{}",
};
const models: ModelInfo[] = [{ id: "qwen3:32b", name: "qwen3:32b", provider: "OLLAMA", capabilities: { thinking: "yes", tools: "yes", vision: "no" } }];

vi.mock("@/lib/llm/registry", () => ({ createProvider: () => fakeProvider, buildProvider: () => fakeProvider, PROVIDER_LABELS: { OLLAMA: "Ollama", OPENAI_COMPATIBLE: "OpenAI" } }));
vi.mock("@/lib/llm/discovery", () => ({
  getModels: async () => ({ provider: { kind: "OLLAMA", reachable: true }, models, fetchedAt: new Date().toISOString() }),
  getModelInfo: async () => models[0],
  invalidateModelCache: () => {},
}));

const chatRoute = await import("@/app/api/chat/route");
const routingRoute = await import("@/app/api/chat/routing/route");
const artifactRoute = await import("@/app/api/artifacts/[id]/route");
const repairRoute = await import("@/app/api/artifacts/[id]/repair/route");
const conversationRoute = await import("@/app/api/conversations/[id]/route");

let fake: FakeJev;
beforeAll(async () => {
  // JEV : le mode interactif est très probable, les autres non.
  fake = await startFakeJev({ noul: (name) => (name === "interactive" ? 0.93 : 0.05) });
});
afterAll(async () => {
  await fake.close();
});

let userId = "";
beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe('TRUNCATE "JevSettings", "RoutingSettings", "RoutingDecision", "Artifact"');
  await db.jevSettings.create({ data: { id: 1, host: "127.0.0.1", port: fake.port, timeoutMs: 2000 } });
  invalidateJevSettings();
  llm.requests = [];
  llm.completeRequests = [];
  const u = await createUser();
  userId = u.id;
  await loginAs(u.id);
  resetRateLimit(`routing:${u.id}`);
  resetRateLimit(`gen:${u.id}`);
});

/** Envoi complet : proposition de routage (mode automatique) puis génération. */
async function send(content: string, extra: { conversationId?: string; artifactKey?: string; overrides?: Record<string, string> } = {}) {
  const p = await routingRoute.POST(jsonRequest("POST", "/api/chat/routing", { content, model: "qwen3:32b", authMode: "AUTO", conversationId: extra.conversationId, overrides: extra.overrides }), {});
  const proposal = await p.json();
  const res = await chatRoute.POST(
    jsonRequest("POST", "/api/chat", { action: "send", content, model: "qwen3:32b", thinking: false, conversationId: extra.conversationId, artifactKey: extra.artifactKey, routing: { decisionId: proposal.decisionId } }),
    {},
  );
  const text = await new Response(res.body).text();
  const events = text.trim().split("\n").map((l) => JSON.parse(l) as StreamEvent);
  return { proposal, events, start: events.find((e) => e.type === "start") as Extract<StreamEvent, { type: "start" }> };
}

const getArtifact = async (id: string) => (await (await artifactRoute.GET(jsonRequest("GET", `/api/artifacts/${id}`), params({ id }))).json()).artifact as ArtifactDTO;
const repair = (id: string, body: Record<string, unknown>) => repairRoute.POST(jsonRequest("POST", `/api/artifacts/${id}/repair`, body), params({ id }));

describe("Pages interactives (artifacts)", () => {
  it("création : bloc retiré du texte, consignes envoyées, v1 enregistrée et restituée", async () => {
    llm.reply = `Les intérêts composés font croître le capital.\n\n<artifact title="Simulateur d'intérêts">\n${PAGE_V1}\n</artifact>`;
    const { proposal, events, start } = await send("Explique les intérêts composés avec un simulateur");
    expect(proposal.outcomes.interactive).toMatchObject({ state: "on", source: "jev" });

    // Consignes du mode interactif dans le message système.
    expect(llm.requests[0].messages[0].content).toMatch(/MODE INTERACTIF/);
    // Le code n'est jamais diffusé dans le texte.
    const streamed = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(streamed).not.toContain("<artifact");
    expect(streamed).not.toContain("<html");
    expect(events.find((e) => e.type === "artifact_start")).toEqual({ type: "artifact_start", title: "Simulateur d'intérêts" });
    const art = events.find((e) => e.type === "artifact") as Extract<StreamEvent, { type: "artifact" }>;
    expect(art.artifact).toMatchObject({ version: 1, title: "Simulateur d'intérêts", valid: true, origin: "GENERATED" });
    expect(art.content).toBe("Les intérêts composés font croître le capital.");

    const msg = await db.message.findUniqueOrThrow({ where: { id: start.assistantMessageId } });
    expect(msg.content).toBe("Les intérêts composés font croître le capital.");
    const dto = await getArtifact(art.artifact.id);
    expect(dto.code).toBe(PAGE_V1);
    expect(dto.versions.map((v) => v.version)).toEqual([1]);

    // Rechargement de la conversation : la carte est restituée.
    const conv = await (await conversationRoute.GET(jsonRequest("GET", `/api/conversations/${start.conversationId}`), params({ id: start.conversationId }))).json();
    expect(conv.conversation.messages[1].artifacts).toEqual([art.artifact]);
  });

  it("modification : Qwen reçoit le code actuel et renvoie une v2 ; historique des versions", async () => {
    llm.reply = `Voici le simulateur.\n<artifact title="Simulateur">${PAGE_V1}</artifact>`;
    const first = await send("Simulateur d'intérêts");
    const v1 = (first.events.find((e) => e.type === "artifact") as Extract<StreamEvent, { type: "artifact" }>).artifact;

    llm.reply = `J'ai agrandi le titre.\n<artifact title="Simulateur">${PAGE_V2}</artifact>`;
    const second = await send("Rends le titre plus grand", { conversationId: first.start.conversationId, artifactKey: v1.key, overrides: { interactive: "on" } });
    const lastReq = llm.requests.at(-1)!;
    expect(lastReq.messages[0].content).toMatch(/MODIFICATION DE LA PAGE INTERACTIVE/);
    expect(lastReq.messages.at(-1)!.content).toContain(`<current_artifact title="Simulateur" version="1">\n${PAGE_V1}`);
    const v2 = (second.events.find((e) => e.type === "artifact") as Extract<StreamEvent, { type: "artifact" }>).artifact;
    expect(v2).toMatchObject({ key: v1.key, version: 2, origin: "EDITED" });
    expect((await getArtifact(v2.id)).versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("erreur dans l'aperçu : une seule correction automatique, puis correction manuelle possible", async () => {
    llm.reply = `Page.\n<artifact title="Démo">${PAGE_V2}</artifact>`;
    const { events } = await send("Démo interactive");
    const v1 = (events.find((e) => e.type === "artifact") as Extract<StreamEvent, { type: "artifact" }>).artifact;

    llm.complete = `<artifact title="Démo">${PAGE_FIXED}</artifact>`;
    const r1 = await repair(v1.id, { problem: "Erreur JavaScript : Cannot set properties of null (ligne 1)", auto: true });
    expect(r1.status).toBe(200);
    const v2 = (await r1.json()).artifact as ArtifactDTO;
    expect(v2).toMatchObject({ version: 2, origin: "REPAIRED", code: PAGE_FIXED, messageId: (await db.artifact.findUniqueOrThrow({ where: { id: v1.id } })).messageId });
    const repairReq = llm.completeRequests.at(-1)!;
    expect(repairReq.messages.at(-1)!.content).toContain("Cannot set properties of null");
    expect(repairReq.messages.at(-1)!.content).toContain(PAGE_V2);
    expect(await db.artifact.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ autoRepairUsed: true, runtimeError: expect.stringContaining("Cannot set") });

    // Ancienne version : correction refusée (une plus récente existe).
    expect((await repair(v1.id, { problem: "x", auto: false })).status).toBe(409);
    // Nouvelle erreur sur v2 : nouvelle tentative automatique autorisée une fois, puis refusée.
    expect((await repair(v2.id, { problem: "Erreur JavaScript : y", auto: true })).status).toBe(200);
    const v3 = await db.artifact.findFirstOrThrow({ where: { key: v1.key, version: 3 } });
    expect((await repair(v3.id, { problem: "z", auto: true })).status).toBe(200);
    const v4 = await db.artifact.findFirstOrThrow({ where: { key: v1.key, version: 4 } });
    await db.artifact.update({ where: { id: v4.id }, data: { autoRepairUsed: true } });
    const refused = await repair(v4.id, { problem: "z", auto: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toMatch(/déjà été tentée/);
    // Correction manuelle (bouton « Régénérer l'artifact ») toujours possible.
    expect((await repair(v4.id, { problem: "z", auto: false })).status).toBe(200);
  });

  it("page incomplète : enregistrée comme inutilisable, avis affiché", async () => {
    llm.reply = `Début.\n<artifact title="Coupée"><html><body><div`;
    const { events } = await send("Page coupée");
    const art = (events.find((e) => e.type === "artifact") as Extract<StreamEvent, { type: "artifact" }>).artifact;
    expect(art.valid).toBe(false);
    expect(art.issues[0]).toMatch(/Page incomplète/);
    expect(events.find((e) => e.type === "notice" && e.code === "artifact_invalid")).toBeTruthy();
  });

  it("mode interactif retenu mais aucune page produite : avis, réponse conservée", async () => {
    llm.reply = "Réponse sans page.";
    const { events, start } = await send("Explique la photosynthèse");
    expect(events.find((e) => e.type === "notice" && e.code === "artifact_missing")).toBeTruthy();
    expect((await db.message.findUniqueOrThrow({ where: { id: start.assistantMessageId } })).status).toBe("COMPLETE");
  });

  it("mode interactif non retenu : ni consignes ni extraction", async () => {
    llm.reply = "Texte avec <artifact title='x'>ne doit pas être extrait</artifact>";
    const { events } = await send("Bonjour", { overrides: { interactive: "off" } });
    expect(llm.requests[0].messages[0].content).not.toMatch(/MODE INTERACTIF/);
    expect(events.some((e) => e.type === "artifact")).toBe(false);
  });

  it("une page n'est accessible qu'à son propriétaire", async () => {
    llm.reply = `x <artifact title="Privée">${PAGE_V1}</artifact>`;
    const { events } = await send("Page privée");
    const art = (events.find((e) => e.type === "artifact") as Extract<StreamEvent, { type: "artifact" }>).artifact;
    const other = await createUser();
    await loginAs(other.id);
    expect((await artifactRoute.GET(jsonRequest("GET", `/api/artifacts/${art.id}`), params({ id: art.id }))).status).toBe(404);
    expect((await repair(art.id, { problem: "x", auto: false })).status).toBe(404);
    expect(userId).not.toBe(other.id);
  });

  it("supprimer la réponse (régénération) supprime ses pages", async () => {
    llm.reply = `x <artifact title="Temp">${PAGE_V1}</artifact>`;
    const { start } = await send("Temp");
    expect(await db.artifact.count()).toBe(1);
    await db.message.delete({ where: { id: start.assistantMessageId } });
    expect(await db.artifact.count()).toBe(0);
  });
});
