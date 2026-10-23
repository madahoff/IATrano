// Banc d'essai sur la pile réellement configurée (aucun simulateur) : serveur IA (LLM + embeddings),
// service de transcription, poppler, ffmpeg, tesseract.js. Désactivé par défaut (durée : 20 à 60 min).
//   DOCS_REAL=1 DOCS_LLM_URL=http://100.121.17.90:11434 DOCS_LLM_MODEL=qwen3:32b DOCS_EMBED_MODEL=embeddinggemma \
//   DOCS_ASR_URL=http://127.0.0.1:8090 TEST_DATABASE_URL=… pnpm test:integration tests/integration/documents-real.test.ts
// Rapport Markdown écrit dans DOCS_REPORT (par défaut docs/benchmarks/documents.md).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { StreamEvent } from "@/lib/chat/protocol";
import { createUser, loginAs, params, resetDb } from "../support/fixtures";
import { buildManualPdf, CONTRADICTION_PAGES, METHOD_PAGES, NEEDLES } from "../support/doc-fixtures";

const REAL = process.env.DOCS_REAL === "1";
const LLM_URL = process.env.DOCS_LLM_URL ?? "http://100.121.17.90:11434";
const LLM_MODEL = process.env.DOCS_LLM_MODEL ?? "qwen3:32b";
const EMBED_MODEL = process.env.DOCS_EMBED_MODEL ?? "embeddinggemma";
const ASR_URL = process.env.DOCS_ASR_URL ?? "http://127.0.0.1:8090";
const REPORT = process.env.DOCS_REPORT ?? path.join(process.cwd(), "docs", "benchmarks", "documents.md");

const STORAGE = mkdtempSync(path.join(tmpdir(), "iatrano-docs-real-"));
process.env.DOCUMENT_STORAGE_DIR = STORAGE;
process.env.DOCUMENT_WORKER = "off";

/** Questions reformulées (vocabulaire différent du document) : mesure la compréhension, pas la coïncidence des mots. */
const PARAPHRASES = [
  { q: "Quel identifiant faut-il pour ouvrir l'armoire principale ?", page: 3 },
  { q: "Quelle graisse est autorisée pour les roulements ?", page: 57 },
  { q: "Qui livre les relais de protection ?", page: 133 },
  { q: "Où partent les copies de sécurité nocturnes des logs ?", page: 200 },
  { q: "Combien de temps faut-il en moyenne pour revenir à la normale après une panne de courant ?", page: 288 },
  { q: "Dans quelle ville se trouve l'installation pilote du quatrième cas étudié ?", page: 341 },
  { q: "Comment s'appelle le plan de raccordement électrique de référence ?", page: 398 },
];

const CHAT = [
  { q: "Retrouve toutes les méthodes décrites dans le manuel et leurs étapes.", pages: [METHOD_PAGES.calibration, METHOD_PAGES.diagnostic], expect: /calibration[\s\S]*diagnostic|diagnostic[\s\S]*calibration/i },
  { q: "Dans quelles pages la procédure de calibration est-elle expliquée ?", pages: [METHOD_PAGES.calibration], expect: new RegExp(`\\b${METHOD_PAGES.calibration}\\b`) },
  { q: "Compare les approches présentées dans les chapitres 2 et 8.", pages: [METHOD_PAGES.calibration, METHOD_PAGES.diagnostic], expect: /calibration[\s\S]*diagnostic|diagnostic[\s\S]*calibration/i },
  { q: "Existe-t-il des contradictions entre les différentes sections ?", pages: [CONTRADICTION_PAGES.first, CONTRADICTION_PAGES.second], expect: /40[\s\S]*55|55[\s\S]*40/ },
  { q: "Vers quel serveur la sauvegarde des journaux est-elle envoyée, et à quelle heure ?", pages: [200], expect: /MERIDIAN-9/ },
  { q: "Fais une synthèse complète de ce document en conservant les informations techniques importantes.", pages: [], expect: /calibration|seuil|maintenance/i },
  { q: "Quelle est la recette de la tarte tatin donnée dans le manuel ?", pages: [], expect: /(pas|aucun|ne).{0,80}(trouv|mentionn|figur|présent|contient)/i },
];

type Row = Record<string, string | number>;
const report: { sections: Array<{ title: string; lines: string[] }> } = { sections: [] };
const add = (title: string, lines: string[]) => report.sections.push({ title, lines });
const table = (rows: Row[]) => {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  return [`| ${keys.join(" | ")} |`, `|${keys.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${keys.map((k) => String(r[k]).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`)];
};

let projectId = "";
let manualId = "";
let userId = "";

describe.skipIf(!REAL)("banc d'essai documentaire sur la pile réelle", () => {
  let docsRoute: typeof import("@/app/api/projects/[id]/documents/route");
  let searchRoute: typeof import("@/app/api/projects/[id]/documents/search/route");
  let chatRoute: typeof import("@/app/api/chat/route");
  let drain: typeof import("@/lib/documents/worker").drainDocumentJobs;

  async function upload(name: string, body: Buffer) {
    const res = await docsRoute.POST(new Request(`http://localhost:3000/api/projects/${projectId}/documents`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) }, body: new Uint8Array(body) }), params({ id: projectId }));
    return ((await res.json()) as { documents: Array<{ id: string }> }).documents[0].id;
  }

  async function search(q: string, extra = "") {
    const res = await searchRoute.GET(new Request(`http://localhost:3000/x?q=${encodeURIComponent(q)}${extra}`, { headers: { host: "localhost:3000" } }), params({ id: projectId }));
    return (await res.json()) as { results: Array<{ page: number | null; matchMs: number | null; snippet: string }>; durationMs: number; semantic: boolean };
  }

  beforeAll(async () => {
    docsRoute = await import("@/app/api/projects/[id]/documents/route");
    searchRoute = await import("@/app/api/projects/[id]/documents/search/route");
    chatRoute = await import("@/app/api/chat/route");
    drain = (await import("@/lib/documents/worker")).drainDocumentJobs;
    await resetDb();
    await db.$executeRawUnsafe('TRUNCATE "DocumentCache", "DocumentSettings" CASCADE');
    await db.appSettings.upsert({ where: { id: 1 }, update: { baseUrl: LLM_URL, defaultModel: LLM_MODEL, providerType: "OLLAMA", requestTimeoutMs: 300_000 }, create: { id: 1, baseUrl: LLM_URL, defaultModel: LLM_MODEL, requestTimeoutMs: 300_000 } });
    await db.documentSettings.create({ data: { id: 1, embeddingModel: EMBED_MODEL, transcriptionUrl: ASR_URL, transcriptionModel: "small" } });
    (await import("@/lib/documents/settings")).invalidateDocumentSettings();
    userId = (await createUser()).id;
    await loginAs(userId);
    projectId = (await db.project.create({ data: { userId, name: "Banc d'essai" } })).id;
  });

  afterAll(async () => {
    rmSync(STORAGE, { recursive: true, force: true });
    if (!report.sections.length) return;
    mkdirSync(path.dirname(REPORT), { recursive: true });
    const head = [
      "# Banc d'essai — bibliothèque documentaire",
      "",
      `Généré le ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC par \`tests/integration/documents-real.test.ts\` (DOCS_REAL=1).`,
      "",
      `Pile : LLM \`${LLM_MODEL}\` et embeddings \`${EMBED_MODEL}\` sur ${LLM_URL} · transcription ${ASR_URL} · OCR tesseract.js · poppler · PostgreSQL ${(await db.$queryRaw<Array<{ v: string }>>`SELECT current_setting('server_version') AS v`)[0].v}.`,
      "Corpus : manuel synthétique de 400 pages (10 chapitres, 2 pages numérisées, 7 faits uniques, 2 méthodes, 1 contradiction) généré par `tests/support/doc-fixtures.ts` (reproductible).",
      "",
    ];
    writeFileSync(REPORT, [...head, ...report.sections.flatMap((s) => [`## ${s.title}`, "", ...s.lines, ""])].join("\n"));
  });

  it("ingère le PDF de 400 pages (extraction, OCR, index, embeddings, analyse, synthèse)", async () => {
    const started = Date.now();
    let peakRss = 0;
    const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 500);
    const cpu0 = process.cpuUsage();
    manualId = await upload("manuel-exploitation.pdf", buildManualPdf(400, { scannedPages: [150, 151] }));
    let searchableAfter: number | null = null;
    // Traitement par étapes : on note le moment où le document devient interrogeable (avant la fin de l'analyse).
    const watcher = setInterval(async () => {
      if (searchableAfter === null && (await db.projectDocument.findUnique({ where: { id: manualId }, select: { status: true } }))?.status === "READY") searchableAfter = Date.now() - started;
    }, 1000);
    await drain();
    clearInterval(watcher);
    clearInterval(sampler);
    const cpu = process.cpuUsage(cpu0);
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id: manualId } });
    const job = await db.documentJob.findFirstOrThrow({ where: { documentId: manualId }, orderBy: { createdAt: "desc" } });
    const m = job.metrics as Record<string, number>;
    const pages = await db.documentPage.groupBy({ by: ["status", "method"], where: { documentId: manualId }, _count: true });
    const sections = await db.documentSection.groupBy({ by: ["analysisStatus"], where: { documentId: manualId }, _count: true });
    const insights = await db.documentInsight.groupBy({ by: ["kind", "origin"], where: { documentId: manualId, status: "ACTIVE" }, _count: true });
    const size = await db.$queryRaw<Array<{ bytes: bigint }>>`SELECT (SUM(pg_column_size(c.*)))::bigint AS bytes FROM "ProjectDocumentChunk" c WHERE "documentId" = ${manualId}`;
    const ok = pages.filter((p) => p.status === "OK" || p.status === "PARTIAL").reduce((n, p) => n + p._count, 0);
    add("Ingestion du PDF de 400 pages", [
      ...table([
        { mesure: "Statut final", valeur: `${doc.status} / ${doc.stage}` },
        { mesure: "Pages extraites avec contenu (couverture)", valeur: `${ok}/400 (${((ok / 400) * 100).toFixed(1)} %)` },
        { mesure: "Pages lues par OCR", valeur: pages.filter((p) => p.method === "OCR").reduce((n, p) => n + p._count, 0) },
        { mesure: "Passages indexés", valeur: m.segments ?? "?" },
        { mesure: "Sections (analysées)", valeur: sections.map((s) => `${s._count} ${s.analysisStatus}`).join(", ") },
        { mesure: "Connaissances extraites", valeur: insights.map((i) => `${i._count} ${i.kind}${i.kind === "METHOD" ? ` ${i.origin}` : ""}`).join(", ") },
        { mesure: "Interrogeable après", valeur: searchableAfter !== null ? `${(searchableAfter / 1000).toFixed(1)} s` : "?" },
        { mesure: "Durée totale", valeur: `${((Date.now() - started) / 1000).toFixed(1)} s` },
        { mesure: "— extraction (pdftotext)", valeur: `${((m.extractMs ?? 0) / 1000).toFixed(1)} s` },
        { mesure: "— rendu + OCR (2 pages)", valeur: `${(((m.renderMs ?? 0) + (m.ocrMs ?? 0)) / 1000).toFixed(1)} s` },
        { mesure: "— structure et segmentation", valeur: `${((m.segmentMs ?? 0) / 1000).toFixed(1)} s` },
        { mesure: "— embeddings", valeur: `${((m.embedMs ?? 0) / 1000).toFixed(1)} s` },
        { mesure: "— analyse des sections (LLM)", valeur: `${((m.analyzeMs ?? 0) / 1000).toFixed(1)} s pour ${m.analysisCalls ?? 0} appels (${m.analysisCalls ? ((m.analyzeMs ?? 0) / m.analysisCalls / 1000).toFixed(1) : "?"} s/appel)` },
        { mesure: "— synthèse, méthodes, contradictions (LLM)", valeur: `${((m.synthMs ?? 0) / 1000).toFixed(1)} s` },
        { mesure: "Mémoire résidente max. (processus Node)", valeur: `${Math.round(peakRss / 1024 / 1024)} Mo` },
        { mesure: "Temps CPU (processus Node)", valeur: `${((cpu.user + cpu.system) / 1e6).toFixed(1)} s` },
        { mesure: "Taille en base des passages (texte + index + vecteurs)", valeur: `${Math.round(Number(size[0].bytes) / 1024 / 1024)} Mo` },
      ]),
      "",
      doc.warnings.length ? `Limites signalées : ${doc.warnings.join(" ; ")}` : "Aucune limite signalée.",
    ]);
    expect(ok).toBe(400);
    expect(doc.status).toBe("READY");
  }, 4 * 3600_000);

  it("retrouve les faits avec des questions reformulées (lexical seul vs hybride)", async () => {
    const rows: Row[] = [];
    const score = async (mode: "lexical" | "hybride", queries: Array<{ q: string; page: number }>) => {
      let p1 = 0;
      let r5 = 0;
      let mrr = 0;
      const times: number[] = [];
      if (mode === "lexical") await db.documentSettings.update({ where: { id: 1 }, data: { embeddingModel: null } });
      else await db.documentSettings.update({ where: { id: 1 }, data: { embeddingModel: EMBED_MODEL } });
      (await import("@/lib/documents/settings")).invalidateDocumentSettings();
      for (const x of queries) {
        const r = await search(x.q);
        times.push(r.durationMs);
        const pages = r.results.map((y) => y.page);
        const rank = pages.indexOf(x.page);
        if (rank === 0) p1++;
        if (rank >= 0 && rank < 5) r5++;
        if (rank >= 0) mrr += 1 / (rank + 1);
      }
      return { p1: p1 / queries.length, r5: r5 / queries.length, mrr: mrr / queries.length, ms: Math.round(times.reduce((a, b) => a + b, 0) / times.length) };
    };
    const literal = NEEDLES.map((n) => ({ q: n.query, page: n.page }));
    for (const [label, set] of [["formulation proche du texte", literal], ["questions reformulées", PARAPHRASES]] as const) {
      for (const mode of ["lexical", "hybride"] as const) {
        const s = await score(mode, set);
        rows.push({ requêtes: label, recherche: mode === "lexical" ? "BM25 seul" : `BM25 + ${EMBED_MODEL} (RRF)`, "précision@1": s.p1.toFixed(2), "rappel@5": s.r5.toFixed(2), MRR: s.mrr.toFixed(2), "temps moyen": `${s.ms} ms` });
      }
    }
    add("Précision et rappel de la recherche (7 faits, début / milieu / fin)", table(rows));
    expect(rows.find((r) => r.requêtes === "formulation proche du texte" && String(r.recherche).startsWith("BM25 +"))?.["rappel@5"]).toBe("1.00");
  }, 600_000);

  it("répond aux questions du cahier des charges avec des références vérifiées", async () => {
    const rows: Row[] = [];
    const answers: string[] = [];
    let supported = 0;
    let checked = 0;
    let removed = 0;
    for (const c of CHAT) {
      const started = Date.now();
      const res = await chatRoute.POST(new Request("http://localhost:3000/api/chat", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ action: "send", projectId, content: c.q, model: LLM_MODEL, thinking: false, webSearch: false }) }), {});
      const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as StreamEvent);
      const docs = events.find((e) => e.type === "documents") as Extract<StreamEvent, { type: "documents" }> | undefined;
      const final = events.find((e) => e.type === "doc_citations") as Extract<StreamEvent, { type: "doc_citations" }> | undefined;
      const text = final?.content ?? events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
      const citedPages = new Set((docs?.retrieval.sources ?? []).filter((s) => final?.cited.includes(s.n)).flatMap((s) => (s.page != null ? [s.page, s.pageEnd ?? s.page] : [])));
      const pagesHit = c.pages.filter((p) => [...citedPages].some((x) => Math.abs(x - p) <= 1)).length;
      supported += final?.checks.filter((x) => x.supported).length ?? 0;
      checked += final?.checks.length ?? 0;
      removed += final?.removed ?? 0;
      rows.push({
        question: c.q,
        intention: docs?.retrieval.intent ?? "-",
        "passages transmis": docs?.retrieval.sources.length ?? 0,
        "pages attendues citées": c.pages.length ? `${pagesHit}/${c.pages.length}` : "n/a",
        "contenu attendu": c.expect.test(text) ? "oui" : "non",
        "références étayées": final ? `${final.checks.filter((x) => x.supported).length}/${final.checks.length}` : "-",
        "inventées retirées": final?.removed ?? 0,
        durée: `${((Date.now() - started) / 1000).toFixed(1)} s`,
      });
      answers.push(`### ${c.q}\n\n${text.trim()}\n`);
    }
    add("Réponses sourcées (LLM réel)", [
      ...table(rows),
      "",
      `Fidélité des références : ${supported}/${checked} citations étayées par le passage cité (${checked ? ((supported / checked) * 100).toFixed(0) : 0} %), ${removed} référence(s) inventée(s) retirée(s) automatiquement.`,
      "",
      "<details><summary>Réponses complètes</summary>",
      "",
      ...answers,
      "</details>",
    ]);
    expect(rows.length).toBe(CHAT.length);
  }, 3600_000);

  it("transcrit une vidéo parlée et retrouve un passage horodaté", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iatrano-speech-"));
    try {
      const out = path.join(dir, "formation.mp4");
      execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "flite=text='Welcome to this training on sensor calibration. First, isolate the sensor and connect it to the reference bench. Then apply three reference pressures and record the deviations. Finally, correct the gain and file the certificate.':voice=slt", "-f", "lavfi", "-i", "color=c=navy:s=320x240:r=5:d=30", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out]);
      const started = Date.now();
      const id = await upload("formation-calibration.mp4", readFileSync(out));
      await drain();
      const pages = await db.documentPage.findMany({ where: { documentId: id }, orderBy: { number: "asc" } });
      const transcript = pages.filter((p) => p.method === "TRANSCRIPT").map((p) => p.text).join("\n");
      const r = await search("apply three reference pressures", `&documentId=${id}`);
      add("Vidéo (transcription réelle)", [
        ...table([
          { mesure: "Durée de traitement", valeur: `${((Date.now() - started) / 1000).toFixed(1)} s pour 20 s de vidéo` },
          { mesure: "Images clés", valeur: pages.filter((p) => p.method === "KEYFRAME").length },
          { mesure: "Horodatage retrouvé pour « apply three reference pressures »", valeur: r.results[0]?.matchMs != null ? `${(r.results[0].matchMs / 1000).toFixed(0)} s` : "non trouvé" },
        ]),
        "",
        "```",
        transcript.slice(0, 1200),
        "```",
      ]);
      expect(transcript.toLowerCase()).toContain("calibration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900_000);
});
