// Bibliothèque documentaire de bout en bout : vraie base, vrais outils (poppler, ffmpeg, tesseract.js),
// LLM factice déterministe (analyse, synthèse, décomposition) et services factices d'embeddings / transcription.
// Couvre les critères d'acceptation : 400 pages, ordre et références, pages non traitées, recherche début/milieu/fin,
// croisement de chapitres, méthodes, tableaux et images, vidéo horodatée, reprise, réutilisation des index,
// isolation, suppression des dérivés, exactitude des références, erreurs sans blocage.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { GenerateRequest, LlmProvider, ModelInfo, ProviderChunk } from "@/lib/llm/types";
import type { StreamEvent } from "@/lib/chat/protocol";
import { createUser, loginAs, params, resetDb } from "../support/fixtures";
import { buildManualPdf, buildVideo, CHAPTERS, CONTRADICTION_PAGES, METHOD_PAGES, NEEDLES, textImagePng } from "../support/doc-fixtures";
import { buildPdf } from "../support/pdf-writer";

const STORAGE = mkdtempSync(path.join(tmpdir(), "iatrano-docs-test-"));
process.env.DOCUMENT_STORAGE_DIR = STORAGE;
process.env.DOCUMENT_WORKER = "off";

// --- LLM factice : lit les marqueurs [p. N] de l'extrait et produit des analyses déterministes.
const calls = { analysis: 0, synth: 0, decompose: 0, contradiction: 0, chat: 0 };
let chatScript: (req: GenerateRequest) => AsyncGenerator<ProviderChunk> = async function* () {};

function fakeAnalysis(text: string) {
  const lines = text.split("\n");
  const pageOf = (l: string) => Number(/\[p\. (\d+)\]/.exec(l)?.[1] ?? 0) || null;
  const methods = lines
    .filter((l) => /Méthode de [^:]+:/.test(l))
    .map((l) => {
      const name = /(Méthode de [^:]+?)\s*:/.exec(l)![1].trim();
      const steps = [...l.matchAll(/Étape \d : ([^.]+)\./g)].map((m) => m[1]);
      return { name, objective: "Procédure décrite dans le manuel", context: "", explicit: /recommande|s'applique/.test(l), evidence: name, prerequisites: [], steps, tools: [], decisionRules: [], inputs: [], outputs: [], pitfalls: [], limits: [], examples: [], page: pageOf(l) };
    });
  const definitions = lines.filter((l) => /Définition : le seuil critique/.test(l)).map((l) => ({ term: "seuil critique", definition: /est fixé à ([^.]+)/.exec(l)![0], evidence: /le seuil critique est fixé à \d+ volts/.exec(l)![0], page: pageOf(l) }));
  const first = lines.find((l) => l.trim())?.replace(/\[p\. \d+\]\s*/, "") ?? "";
  return { subject: first.slice(0, 80), summary: first.slice(0, 200), concepts: [{ term: "seuil", explanation: "valeur limite", page: pageOf(lines[0]) }], definitions, arguments: [], conclusions: [{ text: "Conclusion de la partie", evidence: first.split(" ").slice(0, 5).join(" "), page: pageOf(lines[0]) }, { text: "Conclusion inventée", evidence: "phrase absente du texte analysé", page: null }], methods, causes: [], examples: [], rules: [], references: [], uncertain: [] };
}

const fakeProvider: LlmProvider = {
  kind: "OLLAMA",
  label: "Fake",
  testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://fake", latencyMs: 1 }),
  listModels: async () => [model],
  chatStream: (req) => {
    calls.chat++;
    return chatScript(req);
  },
  complete: async () => "Titre",
  completeJson: async (req, schema) => {
    const props = (schema as { properties: Record<string, unknown> }).properties;
    const user = req.messages.at(-1)!.content;
    if ("methods" in props) {
      calls.analysis++;
      return JSON.stringify(fakeAnalysis(user));
    }
    if ("overview" in props) {
      calls.synth++;
      const pages = (user.match(/p\. (\d+)/g) ?? []).slice(0, 3).map((m) => Number(m.slice(3)));
      return JSON.stringify({ overview: "Manuel d'exploitation couvrant la calibration, les seuils, la maintenance et le diagnostic.", keyPoints: [{ text: "Les seuils sont révisés au chapitre 7.", pages }], conclusions: [], relations: ["Le chapitre 7 révise le seuil défini au chapitre 3."], openQuestions: [] });
    }
    if ("subQueries" in props) {
      calls.decompose++;
      const questionStart = user.lastIndexOf("Question : ");
      const q = questionStart >= 0 ? user.slice(questionStart + "Question : ".length).trim() : "";
      return JSON.stringify({ subQueries: [q], keywords: ["procédure", "étapes"] });
    }
    if ("contradiction" in props) {
      calls.contradiction++;
      return JSON.stringify({ contradiction: true, explanation: "40 volts contre 55 volts." });
    }
    return "{}";
  },
};
const model: ModelInfo = { id: "fake:32b", name: "fake:32b", provider: "OLLAMA", capabilities: { thinking: "no", tools: "no", vision: "no" } };

vi.mock("@/lib/llm/registry", () => ({ createProvider: () => fakeProvider, buildProvider: () => fakeProvider, PROVIDER_LABELS: { OLLAMA: "Ollama", OPENAI_COMPATIBLE: "OpenAI" } }));
vi.mock("@/lib/llm/discovery", () => ({ getModels: async () => ({ provider: { kind: "OLLAMA", reachable: true }, models: [model], fetchedAt: new Date().toISOString() }), invalidateModelCache: () => {} }));

const docsRoute = await import("@/app/api/projects/[id]/documents/route");
const docRoute = await import("@/app/api/projects/[id]/documents/[documentId]/route");
const searchRoute = await import("@/app/api/projects/[id]/documents/search/route");
const pageRoute = await import("@/app/api/projects/[id]/documents/[documentId]/pages/[number]/route");
const fileRoute = await import("@/app/api/projects/[id]/documents/[documentId]/file/route");
const chatRoute = await import("@/app/api/chat/route");
const { drainDocumentJobs } = await import("@/lib/documents/worker");
const { retrieveForQuestion } = await import("@/lib/documents/retrieval");
const { invalidateDocumentSettings } = await import("@/lib/documents/settings");

// --- Services factices : embeddings (sac de mots haché, déterministe) et transcription (verbose_json).
let embedCalls = 0;
function bow(text: string) {
  const v = new Array(256).fill(0);
  for (const w of text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
    let h = 0;
    for (const c of w.slice(0, 6)) h = (h * 31 + c.charCodeAt(0)) % 256;
    v[h] += 1;
  }
  return v;
}
let fakeServer: Server;
let fakeUrl = "";

async function settle() {
  invalidateDocumentSettings();
  for (let i = 0; i < 20; i++) if ((await drainDocumentJobs()) === 0) return;
}

async function upload(projectId: string, name: string, body: Buffer, replace?: string) {
  const res = await docsRoute.POST(
    new Request(`http://localhost:3000/api/projects/${projectId}/documents${replace ? `?replace=${replace}` : ""}`, {
      method: "POST",
      headers: { host: "localhost:3000", "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      body: new Uint8Array(body),
    }),
    params({ id: projectId }),
  );
  const data = (await res.json()) as { documents?: Array<{ id: string; status: string }>; outcomes?: string[]; error?: { message: string } };
  return { status: res.status, ...data };
}

async function search(projectId: string, q: string, extra = "") {
  const res = await searchRoute.GET(new Request(`http://localhost:3000/api/projects/${projectId}/documents/search?q=${encodeURIComponent(q)}${extra}`, { headers: { host: "localhost:3000" } }), params({ id: projectId }));
  return (await res.json()) as { results: Array<{ documentId: string; page: number | null; section: string | null; snippet: string; type: string; startMs: number | null; matchMs: number | null; occurrences?: number }>; occurrences: number | null; semantic: boolean; durationMs: number };
}

async function chat(body: Record<string, unknown>) {
  const res = await chatRoute.POST(new Request("http://localhost:3000/api/chat", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) }), {});
  const events: StreamEvent[] = [];
  const text = await res.text();
  for (const line of text.split("\n")) if (line.trim()) events.push(JSON.parse(line));
  return events;
}

let userId = "";
let projectId = "";
let manualId = "";
const metrics: Record<string, number> = {};

beforeAll(async () => {
  fakeServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/api/embed") {
        embedCalls++;
        const { input } = JSON.parse(raw) as { input: string[] };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ embeddings: input.map(bow) }));
        return;
      }
      if (req.url === "/v1/audio/transcriptions") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ language: "fr", segments: [{ start: 1.5, end: 5, text: "Bienvenue dans cette formation sur la calibration des sondes.", avg_logprob: -0.2 }, { start: 9, end: 14, text: "Nous réglons maintenant le seuil critique à quarante volts.", avg_logprob: -0.3 }, { start: 15, end: 18, text: "mot inaudible", avg_logprob: -2.5 }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
  fakeUrl = `http://127.0.0.1:${(fakeServer.address() as { port: number }).port}`;

  await resetDb();
  await db.$executeRawUnsafe('TRUNCATE "DocumentCache", "DocumentSettings" CASCADE');
  await db.appSettings.upsert({ where: { id: 1 }, update: { defaultModel: "fake:32b", baseUrl: fakeUrl }, create: { id: 1, defaultModel: "fake:32b", baseUrl: fakeUrl } });
  await db.documentSettings.create({ data: { id: 1, embeddingModel: null, ocrEnabled: true, analysisEnabled: true, transcriptionUrl: fakeUrl } });
  invalidateDocumentSettings();
  const u = await createUser();
  userId = u.id;
  await loginAs(userId);
  projectId = (await db.project.create({ data: { userId, name: "Manuel" } })).id;

  const pdf = buildManualPdf(400, { scannedPages: [150, 151] });
  const t0 = Date.now();
  const up = await upload(projectId, "manuel-exploitation.pdf", pdf);
  metrics.uploadMs = Date.now() - t0;
  expect(up.status).toBe(200);
  manualId = up.documents![0].id;
  const t1 = Date.now();
  await settle();
  metrics.ingestMs = Date.now() - t1;
}, 600_000);

afterAll(async () => {
  await new Promise((r) => fakeServer?.close(r));
  rmSync(STORAGE, { recursive: true, force: true });
  console.log("Mesures documents :", JSON.stringify(metrics));
});

describe("ingestion d'un PDF de 400 pages", () => {
  it("traite toutes les pages, dans l'ordre, et lit les pages numérisées par OCR", async () => {
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id: manualId } });
    expect(doc.status).toBe("READY");
    expect(doc.stage).toBe("DONE");
    expect(doc.unitCount).toBe(400);
    const pages = await db.documentPage.findMany({ where: { documentId: manualId }, orderBy: { number: "asc" } });
    expect(pages.map((p) => p.number)).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
    const ok = pages.filter((p) => p.status === "OK" || p.status === "PARTIAL").length;
    metrics.pageCoverage = ok / 400;
    expect(ok).toBe(400);
    const scanned = pages.filter((p) => p.method === "OCR");
    expect(scanned.map((p) => p.number)).toEqual([150, 151]);
    expect(scanned[1].text).toMatch(/Partie 4 du chapitre 4/);
    // Chaque page porte son propre numéro (pied de page) : l'ordre et la référence sont conservés.
    for (const n of [1, 77, 250, 400]) expect(pages[n - 1].text).toMatch(new RegExp(`(^|\\n)${n}$`));
    metrics.segments = await db.projectDocumentChunk.count({ where: { documentId: manualId } });
    expect(metrics.segments).toBeGreaterThan(300);
  });

  it("produit la structure hiérarchique et des segments localisés", async () => {
    const sections = await db.documentSection.findMany({ where: { documentId: manualId, level: 1 }, orderBy: { ordinal: "asc" } });
    expect(sections.map((s) => s.title)).toEqual(CHAPTERS.map((c, i) => `Chapitre ${i + 1} ${c}`));
    expect(sections[6].pageStart).toBe(241);
    const chunks = await db.projectDocumentChunk.findMany({ where: { documentId: manualId }, orderBy: { ordinal: "asc" }, select: { page: true, sectionPath: true, content: true } });
    // Pages croissantes avec l'ordre des segments.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].page!).toBeGreaterThanOrEqual(chunks[i - 1].page!);
    expect(chunks.every((c) => c.sectionPath.length >= 1)).toBe(true);
    expect(chunks.some((c) => c.content.includes("MANUEL D'EXPLOITATION"))).toBe(false);
  });

  it("retrouve une information précise au début, au milieu et à la fin (précision et rappel)", async () => {
    let hitsAt1 = 0;
    let found = 0;
    const times: number[] = [];
    for (const needle of NEEDLES) {
      const r = await search(projectId, needle.query);
      times.push(r.durationMs);
      const pages = r.results.slice(0, 5).map((x) => x.page);
      if (r.results[0]?.page === needle.page) hitsAt1++;
      if (pages.includes(needle.page)) found++;
    }
    metrics.precisionAt1 = hitsAt1 / NEEDLES.length;
    metrics.recallAt5 = found / NEEDLES.length;
    metrics.searchMsAvg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    expect(metrics.recallAt5).toBe(1);
    expect(metrics.precisionAt1).toBeGreaterThanOrEqual(0.85);
    const exact = await search(projectId, "MERIDIAN-9", "&mode=exact");
    expect(exact.results.map((r) => r.page)).toEqual([200]);
  });

  it("trouve toutes les occurrences d'une notion et leurs pages", async () => {
    const r = await search(projectId, "seuil critique", "&mode=occurrences");
    expect(r.results.map((x) => x.page).sort((a, b) => a! - b!)).toEqual([CONTRADICTION_PAGES.first, CONTRADICTION_PAGES.second]);
  });

  it("extrait et compare les méthodes, signale la contradiction", async () => {
    const insights = await db.documentInsight.findMany({ where: { documentId: manualId, status: "ACTIVE" } });
    const methods = insights.filter((i) => i.kind === "METHOD");
    const calib = methods.find((m) => /calibration/i.test(m.title));
    const diag = methods.find((m) => /diagnostic/i.test(m.title));
    expect(calib && diag).toBeTruthy();
    expect((calib!.content as { steps: string[] }).steps).toHaveLength(3);
    expect((calib!.sources as Array<{ page: number }>)[0].page).toBe(METHOD_PAGES.calibration);
    expect(calib!.origin).toBe("EXPLICIT");
    expect(insights.some((i) => i.kind === "SUMMARY")).toBe(true);
    const contra = insights.find((i) => i.kind === "CONTRADICTION" && /seuil critique/.test(i.title));
    expect(contra?.text).toMatch(/40 volts/);
    expect(contra?.text).toMatch(/55 volts/);
    // Les synthèses ne deviennent pas des souvenirs automatiques (elles restent consultables par la recherche).
    expect(await db.memory.count({ where: { projectId, sourceDocumentId: manualId } })).toBe(0);

    const r = await retrieveForQuestion({ userId, projectId, question: "Compare les méthodes présentées dans les chapitres 2 et 8.", llm: { provider: fakeProvider, model: "fake:32b", think: undefined }, budgetTokens: 6000, maxPassages: 10 });
    expect(r!.intent).toBe("compare");
    const pages = r!.passages.filter((p) => !p.derived).map((p) => p.page!);
    expect(pages.some((p) => p >= 41 && p <= 80)).toBe(true);
    expect(pages.some((p) => p >= 281 && p <= 320)).toBe(true);
    expect(r!.passages.some((p) => p.derived && /Méthode/.test(p.section ?? ""))).toBe(true);
  });

  it("croise plusieurs chapitres pour une question transversale", async () => {
    const r = await retrieveForQuestion({ userId, projectId, question: "Quel est le seuil critique et a-t-il changé entre les différentes sections ?", llm: { provider: fakeProvider, model: "fake:32b", think: undefined }, budgetTokens: 6000, maxPassages: 10 });
    const pages = r!.passages.map((p) => p.page);
    expect(pages).toContain(CONTRADICTION_PAGES.first);
    expect(pages).toContain(CONTRADICTION_PAGES.second);
  });

  it("donne accès au passage original et au fichier (requête Range)", async () => {
    const res = await pageRoute.GET(new Request("http://localhost:3000/x", { headers: { host: "localhost:3000" } }), params({ id: projectId, documentId: manualId, number: "200" }));
    const data = (await res.json()) as { page: { text: string }; section: string[] };
    expect(data.page.text).toContain("MERIDIAN-9");
    expect(data.section[0]).toBe("Chapitre 5 Sécurité électrique");
    const file = await fileRoute.GET(new Request("http://localhost:3000/x", { headers: { host: "localhost:3000", range: "bytes=0-7" } }), params({ id: projectId, documentId: manualId }));
    expect(file.status).toBe(206);
    expect(Buffer.from(await file.arrayBuffer()).toString("latin1")).toBe("%PDF-1.4");
  });
});

describe("réponses sourcées dans le chat", () => {
  it("transmet les passages, retire les références inventées et vérifie celles qui restent", async () => {
    const conv = await db.conversation.create({ data: { userId, projectId, model: "fake:32b", webSearch: false } });
    let prompt = "";
    chatScript = async function* (req) {
      prompt = req.messages.at(-1)!.content;
      const n = /\[D(\d+)\][^\n]*\n[^\n]*MERIDIAN-9/.exec(prompt)?.[1] ?? "1";
      const other = [...prompt.matchAll(/^\[D(\d+)\]/gm)].map((m) => m[1]).find((k) => k !== n) ?? n;
      yield { type: "text", delta: `La sauvegarde quotidienne des journaux est envoyée vers le serveur MERIDIAN-9 [D${n}]. Elle date de 1850 [D${other}]. Voir aussi [D42].` };
      yield { type: "done" };
    };
    const events = await chat({ action: "send", conversationId: conv.id, content: "Vers quel serveur la sauvegarde des journaux est-elle envoyée ?", model: "fake:32b", thinking: false, webSearch: false });
    expect(prompt).toContain("<project_documents>");
    expect(prompt).toContain("MERIDIAN-9");
    const docs = events.find((e) => e.type === "documents") as Extract<StreamEvent, { type: "documents" }>;
    expect(docs.retrieval.sources.length).toBeGreaterThan(0);
    const final = events.find((e) => e.type === "doc_citations") as Extract<StreamEvent, { type: "doc_citations" }>;
    expect(final.removed).toBe(1);
    expect(final.content).not.toContain("[D42]");
    const supported = final.checks.filter((c) => c.supported).map((c) => c.n);
    const weak = final.checks.filter((c) => !c.supported).map((c) => c.n);
    // La phrase inventée (« 1850 ») est signalée ; la phrase exacte est étayée si elle cite un autre passage.
    expect(weak).toHaveLength(1);
    expect(supported.length + weak.length).toBe(final.cited.length);
    expect(events.some((e) => e.type === "notice" && e.code === "doc_citations_weak")).toBe(true);
    const msg = await db.message.findFirstOrThrow({ where: { conversationId: conv.id, role: "ASSISTANT" }, include: { documentRetrieval: true } });
    expect(msg.documentRetrieval?.cited).toEqual(final.cited);
    const meridian = Number(/MERIDIAN-9 \[D(\d+)\]/.exec(final.content)![1]);
    const src = (msg.documentRetrieval!.sources as Array<{ n: number; page: number; name: string }>).find((s) => s.n === meridian);
    expect(src?.page).toBe(200);
    expect(src?.name).toBe("manuel-exploitation.pdf");
  });

  it("indique clairement l'absence de passage pertinent", async () => {
    const r = await retrieveForQuestion({ userId, projectId, question: "Quelle est la recette de la tarte tatin ?", llm: null, budgetTokens: 4000, maxPassages: 8 });
    expect(r!.passages.length === 0 || r!.passages.every((p) => !/tatin/i.test(p.content))).toBe(true);
  });
});

describe("mises à jour, reprise et réutilisation", () => {
  it("ne retraite pas un document identique et réutilise les analyses d'une nouvelle version", async () => {
    const before = { ...calls };
    const again = await upload(projectId, "manuel-copie.pdf", buildManualPdf(400, { scannedPages: [150, 151] }));
    expect(again.outcomes).toEqual(["duplicate"]);
    expect(again.documents![0].id).toBe(manualId);
    expect(await db.documentJob.count({ where: { documentId: manualId, status: "PENDING" } })).toBe(0);

    // Nouvelle version : 2 pages modifiées (fait de la page 200 remplacé). Les autres sections ne sont pas réanalysées.
    const pdf = buildManualPdf(400, { scannedPages: [150, 151] }).toString("latin1").replace("MERIDIAN-9", "MERIDIAN-X").replace("ORCHIDEE-42", "ORCHIDEE-77");
    const up = await upload(projectId, "manuel-exploitation.pdf", Buffer.from(pdf, "latin1"), manualId);
    expect(up.outcomes).toEqual(["new_version"]);
    await settle();
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id: manualId }, include: { versions: { orderBy: { version: "asc" } } } });
    expect(doc.version).toBe(2);
    const changes = doc.versions[1].changes as { segmentsReused: number; segmentsNew: number; sectionsChanged: number };
    expect(changes.segmentsNew).toBeLessThanOrEqual(4);
    expect(changes.sectionsChanged).toBeLessThanOrEqual(2);
    expect(calls.analysis - before.analysis).toBeLessThanOrEqual(2);
    const r = await search(projectId, "MERIDIAN-X", "&mode=exact");
    expect(r.results.map((x) => x.page)).toEqual([200]);
    expect((await search(projectId, "MERIDIAN-9", "&mode=exact")).results).toHaveLength(0);
    // Connaissances de la version précédente : conservées pour traçabilité, jamais actives.
    expect(await db.documentInsight.count({ where: { documentId: manualId, status: "ACTIVE", version: 1 } })).toBe(0);
    expect(await db.documentInsight.count({ where: { documentId: manualId, status: "ACTIVE", version: 2 } })).toBeGreaterThan(0);
  }, 300_000);

  it("reprend un traitement interrompu là où il s'était arrêté", async () => {
    const pdf = buildPdf(Array.from({ length: 30 }, (_, i) => ({ kind: "text" as const, lines: [`Chapitre ${i + 1} Thème ${i + 1}`, "", ...Array.from({ length: 40 }, (_, k) => `Le paragraphe ${k} de la page ${i + 1} décrit le réglage numéro ${i + 1} du système et ses tolérances.`)] })));
    const up = await upload(projectId, "reprise.pdf", pdf);
    const id = up.documents![0].id;
    // Simule un arrêt du processus pendant l'analyse : l'appel LLM de la 5e section lève une erreur fatale et le bail expire.
    const job = await db.documentJob.findFirstOrThrow({ where: { documentId: id } });
    let n = 0;
    const original = fakeProvider.completeJson;
    fakeProvider.completeJson = async (req, schema) => {
      if ("methods" in (schema as { properties: object }).properties && ++n === 5) {
        await db.documentJob.update({ where: { id: job.id }, data: { lockedBy: "processus-disparu" } });
      }
      return original(req, schema);
    };
    await drainDocumentJobs({ maxJobs: 1 });
    fakeProvider.completeJson = original;
    const mid = await db.documentSection.count({ where: { documentId: id, analysisStatus: "DONE" } });
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(30);
    // Bail expiré → repris par un autre processus, sans réextraire ni réanalyser ce qui est fait.
    await db.documentJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedAt: new Date(Date.now() - 10 * 60_000) } });
    const before = calls.analysis;
    await settle();
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id } });
    expect(doc.stage).toBe("DONE");
    expect(await db.documentSection.count({ where: { documentId: id, analysisStatus: "DONE" } })).toBe(30);
    // Aucun lot déjà analysé n'est refait ; l'analyse obtenue juste avant l'arrêt est reprise du cache.
    const { packSections } = await import("@/lib/documents/analyze");
    const packs = packSections(await db.documentSection.findMany({ where: { documentId: id }, orderBy: { ordinal: "asc" } }), 4168).length;
    expect(n + (calls.analysis - before)).toBeLessThanOrEqual(packs);
    expect(n + (calls.analysis - before)).toBeGreaterThanOrEqual(packs - 1);
  }, 120_000);
});

describe("formats multimodaux", () => {
  it("indexe un tableau CSV et une image contenant du texte (OCR, sans prétendre l'avoir comprise)", async () => {
    const csv = ["Composant;Seuil;Unité", "Sonde A;40;V", "Sonde B;12,5;bar", "Relais R7;3;A"].join("\n");
    const c = await upload(projectId, "seuils.csv", Buffer.from(csv));
    const png = textImagePng(["Schema du circuit de refroidissement", "Pompe P2 vers echangeur E4"]);
    const i = await upload(projectId, "schema.png", png);
    await settle();
    const table = await search(projectId, "Relais R7", "&type=TABLE");
    expect(table.results[0]?.snippet).toContain("| Composant | Seuil | Unité |");
    const img = await db.documentPage.findFirstOrThrow({ where: { documentId: i.documents![0].id } });
    expect(img.method).toBe("OCR");
    expect(img.text).toMatch(/echangeur E4/i);
    expect(img.visual).toBeNull();
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id: i.documents![0].id } });
    expect(doc.warnings.join(" ")).toMatch(/OCR uniquement/);
    expect(c.documents![0].id).toBeTruthy();
  }, 120_000);

  it("transcrit une vidéo, extrait les images clés et retrouve un passage horodaté", async () => {
    const v = await upload(projectId, "formation.mp4", buildVideo());
    await settle();
    const id = v.documents![0].id;
    const pages = await db.documentPage.findMany({ where: { documentId: id }, orderBy: { number: "asc" } });
    const frames = pages.filter((p) => p.method === "KEYFRAME");
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.map((f) => f.startMs)).toEqual([...frames.map((f) => f.startMs)].sort((a, b) => a! - b!));
    const transcript = pages.find((p) => p.method === "TRANSCRIPT")!;
    expect(transcript.text).toContain("[00:00:09] Nous réglons maintenant le seuil critique");
    expect(transcript.text).toContain("[transcription incertaine]");
    const r = await search(projectId, "seuil critique quarante volts", `&documentId=${id}`);
    expect(r.results[0].type).toBe("TRANSCRIPT");
    expect(r.results[0].matchMs).toBe(9000);
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id } });
    expect(doc.warnings.join(" ")).toMatch(/images clés extraites/);
  }, 180_000);

  it("signale les pages non traitées quand l'OCR est indisponible", async () => {
    await db.documentSettings.update({ where: { id: 1 }, data: { ocrEnabled: false } });
    const pdf = buildManualPdf(8, { scannedPages: [2, 5] });
    const up = await upload(projectId, "scan-partiel.pdf", pdf);
    await settle();
    await db.documentSettings.update({ where: { id: 1 }, data: { ocrEnabled: true } });
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id: up.documents![0].id }, include: { pages: { orderBy: { number: "asc" } } } });
    expect(doc.pages.filter((p) => p.status === "SKIPPED").map((p) => p.number)).toEqual([2, 5]);
    expect(doc.warnings.join(" ")).toMatch(/2 page\(s\) ou image\(s\) non lues/);
    expect(doc.status).toBe("READY");
  }, 120_000);
});

describe("recherche sémantique (embeddings)", () => {
  it("vectorise les segments avec cache et combine lexical + sémantique", async () => {
    await db.documentSettings.update({ where: { id: 1 }, data: { embeddingModel: "fake-embed", embeddingBaseUrl: fakeUrl } });
    invalidateDocumentSettings();
    const { reprocessDocument } = await import("@/lib/documents/service");
    await reprocessDocument(userId, projectId, manualId, "EMBED");
    await settle();
    const missing = await db.projectDocumentChunk.count({ where: { documentId: manualId, embedding: null } });
    expect(missing).toBe(0);
    const r = await search(projectId, "nom de code du schéma de câblage de référence");
    expect(r.semantic).toBe(true);
    // Embeddings factices (sac de mots haché) : on vérifie la fusion, pas la qualité sémantique (mesurée avec le vrai modèle).
    expect(r.results.slice(0, 3).map((x) => x.page)).toContain(398);
    // Second passage : tout vient du cache (aucun nouvel appel au service).
    const callsBefore = embedCalls;
    await reprocessDocument(userId, projectId, manualId, "EMBED");
    await db.projectDocumentChunk.updateMany({ where: { documentId: manualId }, data: { embedding: null } });
    await settle();
    expect(embedCalls - callsBefore).toBe(0);
    await db.documentSettings.update({ where: { id: 1 }, data: { embeddingModel: null } });
    invalidateDocumentSettings();
  }, 300_000);
});

describe("sécurité, isolation et suppression", () => {
  it("isole les documents entre utilisateurs et entre projets", async () => {
    const other = await createUser();
    await loginAs(other.id);
    const theirProject = await db.project.create({ data: { userId: other.id, name: "Autre" } });
    const res = await docRoute.GET(new Request("http://localhost:3000/x", { headers: { host: "localhost:3000" } }), params({ id: projectId, documentId: manualId }));
    expect(res.status).toBe(404);
    const crossed = await docRoute.GET(new Request("http://localhost:3000/x", { headers: { host: "localhost:3000" } }), params({ id: theirProject.id, documentId: manualId }));
    expect(crossed.status).toBe(404);
    expect(await retrieveForQuestion({ userId: other.id, projectId, question: "MERIDIAN", llm: null, budgetTokens: 3000, maxPassages: 5 })).toBeNull();
    // Même utilisateur, autre projet : aucune contamination.
    await loginAs(userId);
    const second = await db.project.create({ data: { userId, name: "Projet vide" } });
    expect(await retrieveForQuestion({ userId, projectId: second.id, question: "MERIDIAN-X", llm: null, budgetTokens: 3000, maxPassages: 5 })).toBeNull();
  });

  it("refuse les fichiers déguisés et ne bloque pas la file sur un PDF corrompu", async () => {
    const fake = await upload(projectId, "facture.pdf", Buffer.from("MZ\x90\x00 programme"));
    expect(fake.status).toBe(400);
    const broken = await upload(projectId, "casse.pdf", Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF"));
    expect(broken.status).toBe(200);
    const ok = await upload(projectId, "note.md", Buffer.from("# Note\n\nLe mot de passe Wi-Fi de l'atelier est ATELIER-2026."));
    await settle();
    const bad = await db.projectDocument.findUniqueOrThrow({ where: { id: broken.documents![0].id } });
    expect(bad.status).toBe("ERROR");
    expect(bad.error).toBeTruthy();
    const good = await db.projectDocument.findUniqueOrThrow({ where: { id: ok.documents![0].id } });
    expect(good.status).toBe("READY");
  }, 180_000);

  it("supprime le document et tout ce qui en dérive", async () => {
    const dir = path.join(STORAGE, projectId, manualId);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(path.join(dir, "pages")).length).toBeGreaterThan(0);
    const res = await docRoute.DELETE(new Request("http://localhost:3000/x", { method: "DELETE", headers: { host: "localhost:3000" } }), params({ id: projectId, documentId: manualId }));
    expect(res.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    for (const count of [
      db.documentPage.count({ where: { documentId: manualId } }),
      db.projectDocumentChunk.count({ where: { documentId: manualId } }),
      db.documentSection.count({ where: { documentId: manualId } }),
      db.documentInsight.count({ where: { documentId: manualId } }),
      db.documentVersion.count({ where: { documentId: manualId } }),
      db.documentJob.count({ where: { documentId: manualId } }),
      db.memory.count({ where: { sourceDocumentId: manualId } }),
    ])
      expect(await count).toBe(0);
    expect((await search(projectId, "MERIDIAN-X", "&mode=exact")).results).toHaveLength(0);
  });
});
