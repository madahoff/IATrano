import "server-only";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma, type DocumentJob, type DocumentSettings, type ProjectDocument, type AppSettings } from "@prisma/client";
import { db } from "@/lib/db";
import { getWindowFor } from "@/lib/context/service";
import { getModels } from "@/lib/llm/discovery";
import { createProvider } from "@/lib/llm/registry";
import { withContextWindow } from "@/lib/llm/with-window";
import { countTextTokens } from "@/lib/llm/tokens";
import { getAppSettings, providerConfigFrom } from "@/lib/settings/service";
import { similarity } from "@/lib/memory/select";
import { waitForChatIdle } from "./activity";
import {
  ANALYSIS_PROMPT_VERSION,
  analysisWindows,
  analyzeWindow,
  checkContradiction,
  consolidateMethods,
  emptyAnalysis,
  formatSources,
  groupDefinitions,
  mergeAnalyses,
  methodText,
  sectionNote,
  synthesisText,
  synthesize,
  type LlmCall,
  type SectionAnalysis,
  type Synthesis,
} from "./analyze";
import { embedDocuments, embeddingConfig, toBytes } from "./embeddings";
import { htmlToMarkdown } from "./extract/html";
import { extractAudioChunks, extractKeyframes, probeMedia, AUDIO_CHUNK_SEC } from "./extract/media";
import { extractPptx, extractXlsx } from "./extract/office";
import { extractPdfPages, pdfInfo, renderPdfPage } from "./extract/pdf";
import { csvUnits, decodeText, jsonText, splitParts } from "./extract/text";
import { cleanOcrText, ocrImage } from "./ocr";
import { dropVectorCache } from "./search";
import { buildStructure, detectBoilerplate, detectLanguage, parseBlocks, recommendedSegmentTokens } from "./segment";
import { ensureDocumentDir, resolveStored } from "./storage";
import { formatTimestamp, transcribeFile, transcriptUnitText } from "./transcribe";
import type { DocumentKindName, DocumentProgress, ExtractedUnit, InsightSource, SectionDraft } from "./types";
import { analyzeImage, imageUnitText } from "./vision";

// Pipeline d'ingestion : EXTRACT → OCR (lecture des pages-images, transcription) → SEGMENT (+ index plein texte)
// → EMBED → ANALYZE (sections) → SYNTHESIZE (synthèse, méthodes, définitions, contradictions) → DONE.
// Chaque étape s'appuie sur l'état persistant (pages « en attente », segments sans vecteur, sections non
// analysées) : une reprise après interruption repart exactement de là où le traitement s'était arrêté.
// Le document devient interrogeable dès la fin de SEGMENT ; l'analyse continue ensuite en arrière-plan.

export const PENDING_MARK = "En attente de lecture (OCR ou transcription)";
export const STAGES = ["EXTRACT", "OCR", "SEGMENT", "EMBED", "ANALYZE", "SYNTHESIZE"] as const;
export type Stage = (typeof STAGES)[number];

export class JobCancelled extends Error {}

export type JobRuntime = {
  job: DocumentJob;
  signal: AbortSignal;
  /** Prolonge le bail du traitement ; lève JobCancelled si le document ou le traitement a disparu. */
  heartbeat: (patch?: { cursor?: Record<string, unknown> }) => Promise<void>;
  metrics: Record<string, number>;
};

type Ctx = JobRuntime & { doc: ProjectDocument; app: AppSettings; settings: DocumentSettings; kind: DocumentKindName; progress: DocumentProgress; warnings: Set<string> };

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 40);

async function saveProgress(ctx: Ctx, stage: Stage | "DONE", extra: Partial<Prisma.ProjectDocumentUpdateInput> = {}) {
  await db.projectDocument.update({
    where: { id: ctx.doc.id },
    data: { stage, progress: ctx.progress as Prisma.InputJsonValue, warnings: [...ctx.warnings].slice(0, 60), ...extra },
  });
  await db.documentJob.update({ where: { id: ctx.job.id }, data: { stage, metrics: ctx.metrics as Prisma.InputJsonValue } });
}

async function timed<T>(ctx: Ctx, key: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    ctx.metrics[key] = (ctx.metrics[key] ?? 0) + (Date.now() - t);
  }
}

async function upsertUnits(documentId: string, units: ExtractedUnit[]) {
  if (!units.length) return;
  await db.$transaction([
    db.documentPage.deleteMany({ where: { documentId, number: { in: units.map((u) => u.number) } } }),
    db.documentPage.createMany({
      data: units.map((u) => ({
        documentId,
        number: u.number,
        label: u.label ?? null,
        method: u.method,
        status: u.status,
        charCount: u.text.length,
        confidence: u.confidence ?? null,
        error: u.needsOcr ? PENDING_MARK : (u.error ?? null),
        text: u.text,
        imagePath: u.imagePath ?? null,
        visual: (u.visual ?? undefined) as Prisma.InputJsonValue | undefined,
        startMs: u.startMs ?? null,
        endMs: u.endMs ?? null,
      })),
    }),
  ]);
}

// ---------------------------------------------------------------- EXTRACT

async function extractStage(ctx: Ctx) {
  const { doc, settings } = ctx;
  if (!doc.storagePath) throw new Error("Fichier original introuvable : réimportez le document.");
  const file = resolveStored(doc.storagePath);
  const cursor = (ctx.job.cursor ?? {}) as { extractFrom?: number };
  const maxUnits = settings.maxUnits;
  ctx.progress.extract = { done: 0, total: 0 };
  if (!cursor.extractFrom) await db.documentPage.deleteMany({ where: { documentId: doc.id } });

  if (ctx.kind === "PDF") {
    const info = await timed(ctx, "extractMs", () => pdfInfo(file, ctx.signal));
    if (info.encrypted) ctx.warnings.add("PDF protégé : l'extraction peut être incomplète si des restrictions de copie s'appliquent.");
    const total = Math.min(info.pages, maxUnits);
    if (info.pages > maxUnits) ctx.warnings.add(`Seules les ${maxUnits} premières pages sur ${info.pages} ont été traitées (limite configurée).`);
    await db.projectDocument.update({ where: { id: doc.id }, data: { unitCount: total, metadata: { ...(doc.metadata as object | null), pdf: info.metadata, pages: info.pages } } });
    ctx.progress.extract = { done: (cursor.extractFrom ?? 1) - 1, total };
    for (let from = cursor.extractFrom ?? 1; from <= total; from += 40) {
      const to = Math.min(total, from + 39);
      const units = await timed(ctx, "extractMs", () => extractPdfPages(file, from, to, ctx.signal));
      await upsertUnits(doc.id, units);
      ctx.progress.extract = { done: to, total };
      await ctx.heartbeat({ cursor: { extractFrom: to + 1 } });
      await saveProgress(ctx, "EXTRACT");
    }
    return;
  }

  let units: ExtractedUnit[] = [];
  const meta: Record<string, unknown> = {};
  const buf = () => readFile(file);
  switch (ctx.kind) {
    case "DOCX": {
      const mammoth = await import("mammoth");
      const imgDir = await ensureDocumentDir(doc.projectId, doc.id, "media");
      const images: Array<{ rel: string; n: number }> = [];
      const result = await mammoth.convertToHtml(
        { buffer: await buf() },
        {
          convertImage: mammoth.images.imgElement(async (image) => {
            const data = await image.readAsBuffer();
            const n = images.length + 1;
            if (data.length >= 15_000 && images.length < 60) {
              const ext = /png/.test(image.contentType) ? "png" : /jpe?g/.test(image.contentType) ? "jpg" : null;
              if (ext) {
                const rel = path.join(imgDir, `image-${String(n).padStart(3, "0")}.${ext}`);
                await writeFile(resolveStored(rel), data);
                images.push({ rel, n });
                return { src: "", alt: `Image ${n}` };
              }
            }
            return { src: "" };
          }),
        },
      );
      for (const m of result.messages.filter((x) => x.type === "warning").slice(0, 3)) ctx.warnings.add(`Word : ${m.message.slice(0, 160)}`);
      units = splitParts(htmlToMarkdown(result.value));
      for (const img of images) units.push({ number: units.length + 1, label: `Image ${img.n} du document`, method: "NONE", status: "SKIPPED", text: "", imagePath: img.rel, needsOcr: true });
      break;
    }
    case "PPTX": {
      const r = extractPptx(new Uint8Array(await buf()));
      units = r.units;
      if (r.title) meta.title = r.title;
      const imgDir = await ensureDocumentDir(doc.projectId, doc.id, "media");
      for (const img of r.images.slice(0, 80)) {
        const rel = path.join(imgDir, `slide-${String(img.slide).padStart(3, "0")}-${img.name.replace(/[^\w.-]/g, "_")}`);
        await writeFile(resolveStored(rel), img.data);
        units.push({ number: units.length + 1, label: `Image de la diapositive ${img.slide}`, method: "NONE", status: "SKIPPED", text: "", imagePath: rel, needsOcr: true });
      }
      if (r.images.length > 80) ctx.warnings.add(`${r.images.length - 80} images de diapositives n'ont pas été lues (limite de 80).`);
      break;
    }
    case "XLSX": {
      const r = extractXlsx(new Uint8Array(await buf()));
      units = r.units;
      r.warnings.forEach((w) => ctx.warnings.add(w));
      break;
    }
    case "CSV": {
      const r = csvUnits(decodeText(await buf()));
      units = r.units;
      r.warnings.forEach((w) => ctx.warnings.add(w));
      break;
    }
    case "JSON":
      units = splitParts(jsonText(decodeText(await buf())));
      break;
    case "HTML":
      units = splitParts(htmlToMarkdown(decodeText(await buf())));
      break;
    case "TEXT":
    case "MARKDOWN":
      units = splitParts(decodeText(await buf()));
      break;
    case "IMAGE":
      units = [{ number: 1, label: "Image", method: "NONE", status: "SKIPPED", text: "", imagePath: doc.storagePath, needsOcr: true }];
      break;
    case "VIDEO":
    case "AUDIO": {
      const probe = await timed(ctx, "extractMs", () => probeMedia(file, ctx.signal));
      meta.media = { durationMs: probe.durationMs, width: probe.width, height: probe.height, hasAudio: probe.hasAudio, tags: probe.metadata };
      const mediaDir = await ensureDocumentDir(doc.projectId, doc.id, "media");
      const drafts: ExtractedUnit[] = [];
      if (probe.hasAudio) {
        const chunks = await timed(ctx, "extractMs", () => extractAudioChunks(file, resolveStored(mediaDir), probe.durationMs, ctx.signal));
        chunks.forEach((abs, i) => {
          const startMs = i * AUDIO_CHUNK_SEC * 1000;
          const endMs = Math.min(probe.durationMs, (i + 1) * AUDIO_CHUNK_SEC * 1000);
          drafts.push({ number: 0, label: `Audio ${formatTimestamp(startMs)} – ${formatTimestamp(endMs)}`, method: "TRANSCRIPT", status: "SKIPPED", text: "", imagePath: path.join(mediaDir, path.basename(abs)), startMs, endMs, needsOcr: true });
        });
      } else ctx.warnings.add("Aucune piste audio : seules les images ont été analysées.");
      if (probe.hasVideo && ctx.kind === "VIDEO") {
        const maxFrames = Math.min(240, Math.max(20, Math.ceil(probe.durationMs / 15_000)));
        const frames = await timed(ctx, "extractMs", () => extractKeyframes(file, resolveStored(mediaDir), probe.durationMs, { maxFrames, signal: ctx.signal }));
        for (const f of frames) drafts.push({ number: 0, label: `Image clé ${formatTimestamp(f.ms)}`, method: "KEYFRAME", status: "SKIPPED", text: "", imagePath: path.join(mediaDir, path.basename(f.file)), startMs: f.ms, endMs: f.ms, needsOcr: true });
        meta.keyframes = frames.length;
        ctx.warnings.add(`Vidéo : ${frames.length} images clés extraites (changements de scène, au moins une par minute) ; les autres images ne sont pas analysées.`);
      }
      units = drafts.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0) || (a.method === "TRANSCRIPT" ? -1 : 1)).map((u, i) => ({ ...u, number: i + 1 }));
      break;
    }
    default:
      throw new Error(`Format ${ctx.kind} non pris en charge par le pipeline.`);
  }
  if (units.length > maxUnits) {
    ctx.warnings.add(`Seules les ${maxUnits} premières unités sur ${units.length} ont été traitées (limite configurée).`);
    units = units.slice(0, maxUnits);
  }
  if (!units.length) throw new Error("Aucun contenu exploitable n'a été trouvé dans ce fichier.");
  for (let i = 0; i < units.length; i += 200) await upsertUnits(doc.id, units.slice(i, i + 200));
  await db.projectDocument.update({ where: { id: doc.id }, data: { unitCount: units.length, metadata: { ...(doc.metadata as object | null), ...meta } as Prisma.InputJsonValue } });
  ctx.progress.extract = { done: units.length, total: units.length };
  await saveProgress(ctx, "EXTRACT");
}

// ---------------------------------------------------------------- OCR / TRANSCRIPTION / VISION

async function readStage(ctx: Ctx) {
  const { doc, settings, app } = ctx;
  const pending = await db.documentPage.findMany({ where: { documentId: doc.id, error: PENDING_MARK }, orderBy: { number: "asc" }, select: { id: true, number: true, method: true, imagePath: true, startMs: true, endMs: true, label: true, text: true } });
  const already = ctx.progress.ocr?.done ?? 0;
  const total = already + pending.length;
  ctx.progress.ocr = { done: already, total, failed: ctx.progress.ocr?.failed ?? 0, skipped: ctx.progress.ocr?.skipped ?? 0 };
  if (!pending.length) return;
  const file = doc.storagePath ? resolveStored(doc.storagePath) : "";
  const pagesDir = ctx.kind === "PDF" ? await ensureDocumentDir(doc.projectId, doc.id, "pages") : null;
  const vision = settings.visionModel;
  let noOcr = 0;
  let noAsr = 0;
  let noVision = 0;
  for (const page of pending) {
    await ctx.heartbeat();
    let update: Prisma.DocumentPageUpdateInput;
    try {
      if (page.method === "TRANSCRIPT") {
        if (!settings.transcriptionUrl) {
          noAsr++;
          update = { status: "SKIPPED", error: "Aucun service de transcription configuré (Administration → Documents)." };
        } else {
          const r = await timed(ctx, "transcribeMs", () => transcribeFile({ url: settings.transcriptionUrl!, model: settings.transcriptionModel, file: resolveStored(page.imagePath!), offsetMs: page.startMs ?? 0, signal: ctx.signal }));
          const conf = r.segments.filter((s) => s.confidence != null);
          const confidence = conf.length ? conf.reduce((n, s) => n + s.confidence!, 0) / conf.length : null;
          const text = r.segments.length ? transcriptUnitText(`${formatTimestamp(page.startMs ?? 0)} – ${formatTimestamp(page.endMs ?? 0)}`, r.segments) : "";
          const uncertain = r.segments.filter((s) => s.uncertain).length;
          update = { text, charCount: text.length, status: !text ? "EMPTY" : uncertain > r.segments.length / 3 ? "PARTIAL" : "OK", confidence, error: uncertain ? `${uncertain} passage(s) de transcription incertain(s)` : null };
        }
      } else {
        // Image à lire : page PDF rendue, image intégrée, image clé de vidéo ou image importée.
        let imageRel = page.imagePath;
        if (ctx.kind === "PDF") {
          const abs = await timed(ctx, "renderMs", () => renderPdfPage(file, page.number, resolveStored(pagesDir!), 200, ctx.signal));
          imageRel = path.relative(resolveStored("."), abs);
        }
        if (!imageRel) throw new Error("Image introuvable.");
        const abs = resolveStored(imageRel);
        let ocrText: string | null = null;
        let confidence: number | null = null;
        if (settings.ocrEnabled) {
          const r = await timed(ctx, "ocrMs", () => ocrImage(abs, settings.ocrLanguages, ctx.signal));
          ocrText = cleanOcrText(r.text) || null;
          confidence = r.confidence;
          ctx.metrics.ocrEngine = r.engine === "tesseract" ? 1 : 2;
        } else noOcr++;
        let visual = null;
        if (vision && (ctx.kind !== "PDF" || !ocrText || ocrText.length < 400)) {
          await waitForChatIdle(ctx.signal);
          visual = await timed(ctx, "visionMs", () => analyzeImage(app, vision, abs, ctx.signal)).catch((err: unknown) => {
            ctx.warnings.add(`Analyse visuelle impossible pour ${page.label ?? `l'unité ${page.number}`} : ${err instanceof Error ? err.message.slice(0, 160) : "erreur"}`);
            return null;
          });
        } else if (!vision && ctx.kind !== "PDF") noVision++;
        const heading = page.method === "KEYFRAME" ? `Image clé à ${formatTimestamp(page.startMs ?? 0)}` : (page.label ?? `Image ${page.number}`);
        const text = ctx.kind === "PDF" ? (ocrText ?? "") + (visual ? `\n\n> Légende : description visuelle (${visual.model}) — ${visual.description}` : "") : ocrText || visual ? imageUnitText({ heading, ocr: ocrText, visual }) : "";
        const lowConfidence = confidence !== null && confidence < 0.6;
        update = {
          text: text.trim(),
          charCount: text.trim().length,
          method: ctx.kind === "PDF" ? "OCR" : page.method === "KEYFRAME" ? "KEYFRAME" : "OCR",
          status: !text.trim() ? (settings.ocrEnabled || vision ? "EMPTY" : "SKIPPED") : lowConfidence ? "PARTIAL" : "OK",
          confidence,
          imagePath: imageRel,
          visual: (visual ?? undefined) as Prisma.InputJsonValue | undefined,
          error: !settings.ocrEnabled && !vision ? "OCR désactivé : contenu non lu." : lowConfidence ? `OCR peu fiable (confiance ${Math.round(confidence! * 100)} %)` : null,
        };
      }
    } catch (err) {
      if (ctx.signal.aborted) throw new JobCancelled();
      ctx.progress.ocr.failed = (ctx.progress.ocr.failed ?? 0) + 1;
      update = { status: "FAILED", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    if (update.status === "SKIPPED") ctx.progress.ocr.skipped = (ctx.progress.ocr.skipped ?? 0) + 1;
    await db.documentPage.update({ where: { id: page.id }, data: update });
    ctx.progress.ocr.done++;
    if (ctx.progress.ocr.done % 3 === 0 || ctx.progress.ocr.done === total) await saveProgress(ctx, "OCR");
  }
  if (noOcr) ctx.warnings.add(`${noOcr} page(s) ou image(s) non lues : OCR désactivé.`);
  if (noAsr) ctx.warnings.add(`${noAsr} tranche(s) audio non transcrites : aucun service de transcription n'est configuré.`);
  if (noVision) ctx.warnings.add(`${noVision} image(s) lues par OCR uniquement : aucun modèle vision-langage n'est configuré, les schémas et graphiques ne sont pas interprétés.`);
  const failed = await db.documentPage.count({ where: { documentId: doc.id, status: "FAILED" } });
  if (failed) ctx.warnings.add(`${failed} unité(s) n'ont pas pu être lues (voir l'onglet Pages).`);
  await saveProgress(ctx, "OCR");
}

// ---------------------------------------------------------------- SEGMENT + INDEX

async function loadStructure(ctx: Ctx) {
  const pages = await db.documentPage.findMany({ where: { documentId: ctx.doc.id }, orderBy: { number: "asc" } });
  const units: ExtractedUnit[] = pages.map((p) => ({ number: p.number, label: p.label, method: p.method, status: p.status, text: p.text, startMs: p.startMs, endMs: p.endMs }));
  const plainKinds = new Set<DocumentKindName>(["PDF", "TEXT"]);
  const boilerplate = ctx.kind === "PDF" ? detectBoilerplate(units) : undefined;
  const blocks = parseBlocks(units, { plain: (u) => plainKinds.has(ctx.kind) || u.method === "OCR", boilerplate });
  const window = await getWindowFor(ctx.app.defaultModel ?? "", ctx.app);
  const target = recommendedSegmentTokens(window.capacity, ctx.settings.chunkTargetTokens);
  const title = ctx.doc.name.replace(/\.[^.]+$/, "");
  return { pages, ...buildStructure(blocks, title, { targetTokens: target, overlapTokens: ctx.settings.chunkOverlapTokens }), target };
}

async function segmentStage(ctx: Ctx) {
  const { doc } = ctx;
  const { pages, sections, segments, target } = await timed(ctx, "segmentMs", () => loadStructure(ctx));
  const language = detectLanguage(pages.slice(0, 50).map((p) => p.text).join("\n"));
  const previous = await db.projectDocumentChunk.findMany({ where: { documentId: doc.id }, select: { contentHash: true } });
  const prevSections = await db.documentSection.findMany({ where: { documentId: doc.id }, select: { contentHash: true, analysis: true, analysisStatus: true, analysisModel: true, analyzedAt: true } });
  const oldHashes = new Set(previous.map((p) => p.contentHash));
  const newHashes = new Set(segments.map((s) => s.contentHash));
  const reusedAnalysis = new Map(prevSections.filter((s) => s.analysisStatus === "DONE").map((s) => [s.contentHash, s]));
  await db.$transaction(
    async (tx) => {
      await tx.projectDocumentChunk.deleteMany({ where: { documentId: doc.id } });
      await tx.documentSection.deleteMany({ where: { documentId: doc.id } });
      await tx.documentSection.createMany({
        data: sections.map((s) => {
          const reuse = reusedAnalysis.get(s.contentHash);
          return {
            documentId: doc.id,
            ordinal: s.ordinal,
            level: s.level,
            title: s.title,
            path: s.path,
            pageStart: s.pageStart,
            pageEnd: s.pageEnd,
            startMs: s.startMs,
            endMs: s.endMs,
            tokenCount: s.tokenCount,
            contentHash: s.contentHash,
            analysis: (reuse?.analysis ?? undefined) as Prisma.InputJsonValue | undefined,
            analysisStatus: reuse ? "DONE" : "PENDING",
            analysisModel: reuse?.analysisModel ?? null,
            analyzedAt: reuse?.analyzedAt ?? null,
          };
        }),
      });
      const ids = new Map((await tx.documentSection.findMany({ where: { documentId: doc.id }, select: { id: true, ordinal: true } })).map((s) => [s.ordinal, s.id]));
      for (let i = 0; i < segments.length; i += 500) {
        await tx.projectDocumentChunk.createMany({
          data: segments.slice(i, i + 500).map((s) => ({
            documentId: doc.id,
            ordinal: s.ordinal,
            content: s.content,
            tokenCount: s.tokenCount,
            page: s.page,
            pageEnd: s.pageEnd,
            sectionId: s.sectionOrdinal != null ? (ids.get(s.sectionOrdinal) ?? null) : null,
            sectionPath: s.sectionPath,
            type: s.type,
            startMs: s.startMs,
            endMs: s.endMs,
            contentHash: s.contentHash,
          })),
        });
      }
      // Index plein texte : titres de section (poids B) + contenu, sans accents, dans la langue du document.
      await tx.$executeRaw`
        UPDATE "ProjectDocumentChunk" SET "tsv" =
          setweight(to_tsvector(${language}::regconfig, iatrano_unaccent(array_to_string("sectionPath", ' '))), 'B') ||
          to_tsvector(${language}::regconfig, iatrano_unaccent("content"))
        WHERE "documentId" = ${doc.id}`;
      await tx.$executeRaw`
        UPDATE "ProjectDocumentChunk" c SET "lexCount" = (SELECT COALESCE(SUM(array_length(u.positions, 1)), 0) FROM unnest(c."tsv") u)
        WHERE c."documentId" = ${doc.id}`;
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
  dropVectorCache(doc.id);
  const changes = {
    segments: segments.length,
    segmentsReused: [...newHashes].filter((h) => oldHashes.has(h)).length,
    segmentsNew: [...newHashes].filter((h) => !oldHashes.has(h)).length,
    segmentsRemoved: [...oldHashes].filter((h) => !newHashes.has(h)).length,
    sectionsReused: sections.filter((s) => reusedAnalysis.has(s.contentHash)).length,
    sectionsChanged: sections.filter((s) => !reusedAnalysis.has(s.contentHash)).length,
  };
  if (previous.length) await db.documentVersion.updateMany({ where: { documentId: doc.id, version: doc.version }, data: { changes } });
  // Connaissances liées à des sections disparues : invalidées (conservées pour traçabilité, jamais injectées).
  const live = new Set(sections.map((s) => s.contentHash));
  const insights = await db.documentInsight.findMany({ where: { documentId: doc.id, status: "ACTIVE" }, select: { id: true, sectionIds: true } });
  const stale = insights.filter((i) => i.sectionIds.length && i.sectionIds.some((h) => !live.has(h))).map((i) => i.id);
  if (stale.length) await db.documentInsight.updateMany({ where: { id: { in: stale } }, data: { status: "STALE" } });
  const extractable = pages.filter((p) => p.status === "OK" || p.status === "PARTIAL").length;
  ctx.metrics.segments = segments.length;
  ctx.metrics.sections = sections.length;
  ctx.metrics.segmentTokens = target;
  ctx.progress.segment = { done: segments.length, total: segments.length, note: `${sections.length} sections · ${extractable}/${pages.length} unités avec contenu` };
  if (!segments.length) throw new Error("Aucun texte exploitable n'a été extrait de ce document (voir l'onglet Pages).");
  await saveProgress(ctx, "SEGMENT", { status: "READY", error: null, language, indexedAt: new Date() });
}

// ---------------------------------------------------------------- EMBED

async function embedStage(ctx: Ctx) {
  const cfg = embeddingConfig(ctx.app, ctx.settings);
  if (!cfg) {
    ctx.progress.embed = { done: 0, total: 0, note: "Recherche sémantique désactivée (aucun modèle d'embeddings configuré) : recherche lexicale uniquement." };
    await saveProgress(ctx, "EMBED");
    return;
  }
  const total = await db.projectDocumentChunk.count({ where: { documentId: ctx.doc.id } });
  let failures = 0;
  for (;;) {
    const batch = await db.projectDocumentChunk.findMany({
      where: { documentId: ctx.doc.id, OR: [{ embedding: null }, { embeddingModel: { not: cfg.model } }] },
      orderBy: { ordinal: "asc" },
      take: 32,
      select: { id: true, content: true, contentHash: true, sectionPath: true },
    });
    if (!batch.length) break;
    await ctx.heartbeat();
    try {
      const { vectors, reused } = await timed(ctx, "embedMs", () =>
        embedDocuments(cfg, batch.map((c) => ({ hash: c.contentHash, text: `${c.sectionPath.join(" › ")}\n${c.content}`.slice(0, 8000) })), ctx.signal),
      );
      ctx.metrics.embedReused = (ctx.metrics.embedReused ?? 0) + reused;
      await db.$transaction(batch.map((c, i) => db.projectDocumentChunk.update({ where: { id: c.id }, data: { embedding: toBytes(vectors[i]), embeddingModel: cfg.model } })));
    } catch (err) {
      if (ctx.signal.aborted) throw new JobCancelled();
      if (++failures >= 3) {
        ctx.warnings.add(`Recherche sémantique indisponible pour ce document (${err instanceof Error ? err.message.slice(0, 160) : "erreur"}) : recherche lexicale uniquement. Relancez le traitement une fois le modèle d'embeddings joignable.`);
        break;
      }
      await new Promise((r) => setTimeout(r, 3000 * failures));
      continue;
    }
    const done = total - (await db.projectDocumentChunk.count({ where: { documentId: ctx.doc.id, OR: [{ embedding: null }, { embeddingModel: { not: cfg.model } }] } }));
    ctx.progress.embed = { done, total, note: cfg.model };
    await saveProgress(ctx, "EMBED");
  }
  dropVectorCache(ctx.doc.id);
  await db.projectDocument.update({ where: { id: ctx.doc.id }, data: { indexedAt: new Date() } });
}

// ---------------------------------------------------------------- ANALYZE + SYNTHESIZE

async function llmFor(ctx: Ctx): Promise<{ llm: LlmCall; windowTokens: number; validPages: Set<number> } | null> {
  const model = ctx.settings.analysisModel ?? ctx.app.defaultModel ?? (await getModels()).models[0]?.id;
  if (!model) return null;
  const snapshot = await getModels();
  const info = snapshot.models.find((m) => m.id === model) ?? null;
  if (!snapshot.provider.reachable || !info) throw new Error(`Modèle d'analyse « ${model} » indisponible sur le serveur IA.`);
  const window = await getWindowFor(model, ctx.app, info);
  // Même num_ctx que le chat : Ollama ne recharge pas le modèle entre une réponse et une analyse.
  const provider = withContextWindow(createProvider(providerConfigFrom(ctx.app)), window.numCtx);
  const windowTokens = Math.max(1200, Math.min(6000, window.capacity - 3000));
  const pages = await db.documentPage.findMany({ where: { documentId: ctx.doc.id }, select: { number: true } });
  return { llm: { provider, model, think: info.capabilities.thinking === "no" ? undefined : false, signal: ctx.signal }, windowTokens, validPages: new Set(pages.map((p) => p.number)) };
}

async function cachedJson<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = await db.documentCache.findUnique({ where: { key } });
  if (hit?.json) return hit.json as T;
  const value = await compute();
  await db.documentCache.upsert({ where: { key }, create: { key, kind: key.split(":")[0], json: value as Prisma.InputJsonValue }, update: { json: value as Prisma.InputJsonValue } });
  return value;
}

async function analyzeStage(ctx: Ctx) {
  if (!ctx.settings.analysisEnabled) {
    ctx.progress.analyze = { done: 0, total: 0, note: "Analyse désactivée dans l'administration." };
    await saveProgress(ctx, "ANALYZE");
    return;
  }
  const setup = await llmFor(ctx);
  if (!setup) {
    ctx.warnings.add("Analyse non effectuée : aucun modèle n'est configuré.");
    return;
  }
  const { llm, windowTokens } = setup;
  const { sections: drafts } = await loadStructure(ctx);
  const byOrdinal = new Map<number, SectionDraft>(drafts.map((d) => [d.ordinal, d]));
  const sections = await db.documentSection.findMany({ where: { documentId: ctx.doc.id }, orderBy: { ordinal: "asc" } });
  const todo = sections.filter((s) => s.analysisStatus !== "DONE" && s.analysisStatus !== "SKIPPED");
  const total = sections.length;
  ctx.progress.analyze = { done: total - todo.length, total, failed: 0, note: llm.model };
  await saveProgress(ctx, "ANALYZE");
  for (const s of todo) {
    await ctx.heartbeat();
    const draft = byOrdinal.get(s.ordinal);
    const text = draft && draft.contentHash === s.contentHash ? draft.text : (await db.projectDocumentChunk.findMany({ where: { sectionId: s.id }, orderBy: { ordinal: "asc" }, select: { content: true, page: true } })).map((c) => `[p. ${c.page ?? "?"}] ${c.content}`).join("\n");
    if (countTextTokens(text) < 40) {
      await db.documentSection.update({ where: { id: s.id }, data: { analysisStatus: "SKIPPED" } });
      ctx.progress.analyze.done++;
      continue;
    }
    const windows = analysisWindows(text, windowTokens);
    try {
      const parts: SectionAnalysis[] = [];
      for (const [i, w] of windows.entries()) {
        const key = `analysis:v${ANALYSIS_PROMPT_VERSION}:${llm.model}:${sha(`${s.path.join(">")}\n${w}`)}`;
        parts.push(
          await cachedJson(key, async () => {
            await waitForChatIdle(ctx.signal);
            let lastErr: unknown;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                return await timed(ctx, "analyzeMs", () => analyzeWindow(llm, { documentName: ctx.doc.name, sectionPath: s.path, text: w, part: i + 1, parts: windows.length }));
              } catch (err) {
                if (ctx.signal.aborted) throw new JobCancelled();
                lastErr = err;
              }
            }
            throw lastErr;
          }),
        );
        ctx.metrics.analysisCalls = (ctx.metrics.analysisCalls ?? 0) + 1;
        await ctx.heartbeat();
      }
      await db.documentSection.update({ where: { id: s.id }, data: { analysis: mergeAnalyses(parts) as unknown as Prisma.InputJsonValue, analysisStatus: "DONE", analysisModel: llm.model, analyzedAt: new Date() } });
    } catch (err) {
      if (err instanceof JobCancelled || ctx.signal.aborted) throw new JobCancelled();
      ctx.progress.analyze.failed = (ctx.progress.analyze.failed ?? 0) + 1;
      await db.documentSection.update({ where: { id: s.id }, data: { analysisStatus: "FAILED" } });
      ctx.warnings.add(`Analyse impossible pour certaines sections (ex. « ${s.title.slice(0, 60)} ») : ${err instanceof Error ? err.message.slice(0, 160) : "erreur"}. Leurs passages restent consultables par la recherche.`);
    }
    ctx.progress.analyze.done++;
    await saveProgress(ctx, "ANALYZE");
  }
}

async function synthesizeStage(ctx: Ctx) {
  if (!ctx.settings.analysisEnabled) return;
  const setup = await llmFor(ctx);
  if (!setup) return;
  const { llm, windowTokens, validPages } = setup;
  const sections = await db.documentSection.findMany({ where: { documentId: ctx.doc.id }, orderBy: { ordinal: "asc" } });
  const analyzed = sections.filter((s) => s.analysisStatus === "DONE" && s.analysis);
  ctx.progress.synthesize = { done: 0, total: 4 };
  await saveProgress(ctx, "SYNTHESIZE");
  if (!analyzed.length) {
    ctx.warnings.add("Aucune section n'a pu être analysée : pas de synthèse ni de méthodes extraites.");
    return;
  }
  const where = (s: (typeof sections)[number]) => (s.pageStart ? (s.pageEnd && s.pageEnd !== s.pageStart ? `p. ${s.pageStart}–${s.pageEnd}` : `p. ${s.pageStart}`) : s.startMs != null ? formatTimestamp(s.startMs) : "");
  const notes = analyzed.map((s) => sectionNote(s.path, where(s), s.analysis as unknown as SectionAnalysis));
  const version = ctx.doc.version;
  const allHashes = analyzed.map((s) => s.contentHash);

  // 1. Synthèse hiérarchique : lots de fiches tenant dans la fenêtre, puis synthèse des synthèses.
  const reduce = async (items: string[], partial: boolean): Promise<Synthesis> => {
    const joined = items.join("\n\n");
    if (countTextTokens(joined) <= windowTokens) {
      return cachedJson(`synth:v${ANALYSIS_PROMPT_VERSION}:${llm.model}:${sha(joined)}:${partial ? 1 : 0}`, async () => {
        await waitForChatIdle(ctx.signal);
        return timed(ctx, "synthMs", () => synthesize(llm, { documentName: ctx.doc.name, notes: joined, validPages, partial }));
      });
    }
    const batches: string[][] = [];
    let current: string[] = [];
    let tokens = 0;
    for (const n of items) {
      const t = countTextTokens(n);
      if (current.length && tokens + t > windowTokens) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
      current.push(n.slice(0, windowTokens * 3));
      tokens += t;
    }
    if (current.length) batches.push(current);
    const partials: string[] = [];
    for (const [i, b] of batches.entries()) {
      await ctx.heartbeat();
      const s = await reduce(b, true);
      partials.push(`## Partie ${i + 1}\n${s.overview}\n${s.keyPoints.map((k) => `- ${k.text}${k.pages.length ? ` [p. ${k.pages.join(", ")}]` : ""}`).join("\n")}\n${s.conclusions.map((k) => `Conclusion : ${k.text}${k.pages.length ? ` [p. ${k.pages.join(", ")}]` : ""}`).join("\n")}`);
    }
    return reduce(partials, partial);
  };
  const synthesis = await reduce(notes, false);
  ctx.progress.synthesize.done = 1;
  await saveProgress(ctx, "SYNTHESIZE");

  type InsightInput = Omit<Prisma.DocumentInsightCreateManyInput, "documentId" | "projectId" | "version" | "model">;
  const insights: InsightInput[] = [];
  const keyPages = [...new Set([...synthesis.keyPoints, ...synthesis.conclusions].flatMap((k) => k.pages))].sort((a, b) => a - b);
  insights.push({
    kind: "SUMMARY",
    title: `Synthèse — ${ctx.doc.name}`,
    content: synthesis as unknown as Prisma.InputJsonValue,
    text: synthesisText(ctx.doc.name, synthesis),
    origin: "INFERRED",
    sources: keyPages.map((p) => ({ page: p, section: null })) as Prisma.InputJsonValue,
    sectionIds: allHashes,
  });
  if (synthesis.relations.length) {
    insights.push({ kind: "RELATION", title: "Relations entre les parties", content: { relations: synthesis.relations }, text: `Relations entre les parties du document « ${ctx.doc.name} » (déduites par l'IA) :\n${synthesis.relations.map((r) => `- ${r}`).join("\n")}`, origin: "INFERRED", sources: [], sectionIds: allHashes });
  }

  // 2. Méthodes consolidées sur tout le document.
  const methods = consolidateMethods(analyzed.flatMap((s) => (s.analysis as unknown as SectionAnalysis).methods.map((m) => ({ ...m, section: s.path.join(" › ") }))));
  for (const m of methods.slice(0, 80)) {
    const hashes = analyzed.filter((s) => m.sources.some((src) => src.section === s.path.join(" › "))).map((s) => s.contentHash);
    insights.push({ kind: "METHOD", title: m.name, content: m as unknown as Prisma.InputJsonValue, text: methodText(m), origin: m.explicit ? "EXPLICIT" : "INFERRED", sources: m.sources as unknown as Prisma.InputJsonValue, sectionIds: hashes });
  }
  ctx.progress.synthesize.done = 2;

  // 3. Définitions, concepts, règles (agrégation sans LLM) et contradictions vérifiées par le LLM.
  const defs = groupDefinitions(analyzed.flatMap((s) => (s.analysis as unknown as SectionAnalysis).definitions.map((d) => ({ ...d, section: s.path.join(" › ") }))));
  for (const d of defs.slice(0, 120)) {
    const sources: InsightSource[] = d.entries.map((e) => ({ page: e.page, section: e.section }));
    insights.push({ kind: "DEFINITION", title: d.term, content: d as unknown as Prisma.InputJsonValue, text: `Définition de « ${d.term} » dans le document :\n${d.entries.map((e) => `- ${e.definition} (${formatSources([{ page: e.page, section: e.section }])})`).join("\n")}`, origin: "EXPLICIT", sources: sources as unknown as Prisma.InputJsonValue, sectionIds: [] });
  }
  const conceptCounts = new Map<string, { term: string; explanations: string[]; sources: InsightSource[] }>();
  for (const s of analyzed) {
    for (const c of (s.analysis as unknown as SectionAnalysis).concepts) {
      const key = [...conceptCounts.keys()].find((k) => similarity(k, c.term) > 0.85) ?? c.term;
      const entry = conceptCounts.get(key) ?? { term: c.term, explanations: [], sources: [] };
      if (entry.explanations.length < 4 && !entry.explanations.some((e) => similarity(e, c.explanation) > 0.7)) entry.explanations.push(c.explanation);
      entry.sources.push({ page: c.page, section: s.path.join(" › ") });
      conceptCounts.set(key, entry);
    }
  }
  for (const c of [...conceptCounts.values()].sort((a, b) => b.sources.length - a.sources.length).slice(0, 80)) {
    insights.push({ kind: "CONCEPT", title: c.term, content: c as unknown as Prisma.InputJsonValue, text: `Concept « ${c.term} » (${c.sources.length} mention(s) analysée(s)) :\n${c.explanations.map((e) => `- ${e}`).join("\n")}\nSources : ${formatSources(c.sources)}`, origin: "EXPLICIT", sources: c.sources.slice(0, 20) as unknown as Prisma.InputJsonValue, sectionIds: [] });
  }
  const rules = analyzed.flatMap((s) => (s.analysis as unknown as SectionAnalysis).rules.map((r) => ({ ...r, section: s.path.join(" › ") })));
  if (rules.length) {
    insights.push({ kind: "RULE", title: "Règles, contraintes et critères", content: { rules } as unknown as Prisma.InputJsonValue, text: `Règles, contraintes et critères énoncés dans « ${ctx.doc.name} » :\n${rules.slice(0, 80).map((r) => `- ${r.text} (${formatSources([{ page: r.page, section: r.section }])})`).join("\n")}`, origin: "EXPLICIT", sources: rules.slice(0, 40).map((r) => ({ page: r.page, section: r.section })) as unknown as Prisma.InputJsonValue, sectionIds: [] });
  }
  if (ctx.kind === "VIDEO" || ctx.kind === "AUDIO") {
    const timeline = analyzed.filter((s) => s.startMs != null).map((s) => ({ at: s.startMs!, title: s.title, summary: (s.analysis as unknown as SectionAnalysis).summary }));
    if (timeline.length) insights.push({ kind: "TIMELINE", title: "Chronologie", content: { timeline } as unknown as Prisma.InputJsonValue, text: `Chronologie de « ${ctx.doc.name} » :\n${timeline.map((t) => `- [${formatTimestamp(t.at)}] ${t.summary || t.title}`).join("\n")}`, origin: "INFERRED", sources: timeline.map((t) => ({ page: null, section: t.title, startMs: t.at })) as unknown as Prisma.InputJsonValue, sectionIds: [] });
  }
  ctx.progress.synthesize.done = 3;
  await saveProgress(ctx, "SYNTHESIZE");

  let checks = 0;
  for (const d of defs) {
    if (checks >= 8) break;
    if (d.entries.length < 2) continue;
    const [a, b] = d.entries;
    if (similarity(a.definition, b.definition) > 0.35) continue;
    checks++;
    await waitForChatIdle(ctx.signal);
    const r = await timed(ctx, "synthMs", () => checkContradiction(llm, { text: `${d.term} : ${a.definition}`, where: formatSources([{ page: a.page, section: a.section }]) }, { text: `${d.term} : ${b.definition}`, where: formatSources([{ page: b.page, section: b.section }]) })).catch(() => null);
    if (r?.contradiction) {
      insights.push({ kind: "CONTRADICTION", title: `Définitions divergentes de « ${d.term} »`, content: { term: d.term, a, b, explanation: r.explanation } as unknown as Prisma.InputJsonValue, text: `Contradiction possible sur « ${d.term} » (vérifiée par l'IA) : ${r.explanation}\n- ${a.definition} (${formatSources([{ page: a.page, section: a.section }])})\n- ${b.definition} (${formatSources([{ page: b.page, section: b.section }])})`, origin: "INFERRED", sources: [{ page: a.page, section: a.section }, { page: b.page, section: b.section }] as unknown as Prisma.InputJsonValue, sectionIds: [] });
    }
  }
  const uncertain = analyzed.flatMap((s) => (s.analysis as unknown as SectionAnalysis).uncertain.map((u) => ({ ...u, section: s.path.join(" › ") })));
  if (uncertain.length) {
    insights.push({ kind: "CONTRADICTION", title: "Passages incertains ou ambigus", content: { items: uncertain } as unknown as Prisma.InputJsonValue, text: `Passages signalés comme incertains, ambigus ou contradictoires dans « ${ctx.doc.name} » :\n${uncertain.slice(0, 60).map((u) => `- ${u.text} (${formatSources([{ page: u.page, section: u.section }])})`).join("\n")}`, origin: "INFERRED", sources: uncertain.slice(0, 40).map((u) => ({ page: u.page, section: u.section })) as unknown as Prisma.InputJsonValue, sectionIds: [] });
  }

  // 4. Remplacement atomique : les connaissances précédentes sont conservées (STALE) pour traçabilité, une version en arrière.
  await db.$transaction([
    db.documentInsight.deleteMany({ where: { documentId: ctx.doc.id, version: { lt: version - 1 } } }),
    db.documentInsight.updateMany({ where: { documentId: ctx.doc.id, status: "ACTIVE" }, data: { status: "STALE" } }),
    db.documentInsight.createMany({ data: insights.map((i) => ({ ...i, documentId: ctx.doc.id, projectId: ctx.doc.projectId, version, model: llm.model })) }),
  ]);
  await syncProjectMemory(ctx, synthesis);
  ctx.progress.synthesize = { done: 4, total: 4, note: `${methods.length} méthode(s), ${defs.length} définition(s), ${insights.filter((i) => i.kind === "CONTRADICTION").length} point(s) de vigilance` };
  ctx.metrics.insights = insights.length;
  await saveProgress(ctx, "SYNTHESIZE", { analyzedAt: new Date() });
}

/** Mémoire de projet : une ligne décrivant le document (source DOCUMENT), remplacée à chaque nouvelle synthèse. */
async function syncProjectMemory(ctx: Ctx, synthesis: Synthesis) {
  const project = await db.project.findUnique({ where: { id: ctx.doc.projectId }, select: { userId: true, memoryEnabled: true } });
  if (!project) return;
  await db.memory.deleteMany({ where: { userId: project.userId, projectId: ctx.doc.projectId, source: "DOCUMENT", sourceDocumentId: ctx.doc.id } });
  if (!project.memoryEnabled || !synthesis.overview) return;
  const overview = synthesis.overview.replace(/\s+/g, " ");
  const content = `Document du projet « ${ctx.doc.name} »${ctx.doc.unitCount ? ` (${ctx.doc.unitCount} ${ctx.kind === "PDF" ? "pages" : "parties"})` : ""} : ${overview.length > 300 ? `${overview.slice(0, 297)}…` : overview}`;
  await db.memory.create({ data: { userId: project.userId, projectId: ctx.doc.projectId, kind: "FACT", content, topic: `document-${ctx.doc.id}`, source: "DOCUMENT", certainty: "STATED", importance: 3, sourceDocumentId: ctx.doc.id } });
}

// ---------------------------------------------------------------- orchestration

const RUNNERS: Record<Stage, (ctx: Ctx) => Promise<void>> = {
  EXTRACT: extractStage,
  OCR: readStage,
  SEGMENT: segmentStage,
  EMBED: embedStage,
  ANALYZE: analyzeStage,
  SYNTHESIZE: synthesizeStage,
};

export async function runDocumentJob(rt: JobRuntime) {
  const doc = await db.projectDocument.findUnique({ where: { id: rt.job.documentId } });
  if (!doc) throw new JobCancelled();
  const [app, settings] = await Promise.all([getAppSettings(), (await import("./settings")).getDocumentSettings()]);
  const wanted = rt.job.stages.length ? STAGES.filter((s) => rt.job.stages.includes(s)) : [...STAGES];
  const startAt = rt.job.stage !== "QUEUED" && rt.job.stage !== "DONE" ? STAGES.indexOf(rt.job.stage as Stage) : 0;
  const ctx: Ctx = {
    ...rt,
    doc,
    app,
    settings,
    kind: doc.kind as DocumentKindName,
    progress: (doc.progress ?? {}) as DocumentProgress,
    warnings: new Set(rt.job.attempts > 1 || startAt > 0 ? doc.warnings : []),
  };
  if (startAt === 0 && wanted[0] === "EXTRACT") ctx.progress = {};
  for (const stage of wanted) {
    if (STAGES.indexOf(stage) < startAt) continue;
    await rt.heartbeat();
    await db.documentJob.update({ where: { id: rt.job.id }, data: { stage } });
    await db.projectDocument.update({ where: { id: doc.id }, data: { stage, status: doc.indexedAt || stage === "EMBED" || stage === "ANALYZE" || stage === "SYNTHESIZE" ? undefined : "PROCESSING" } });
    await RUNNERS[stage](ctx);
    ctx.doc = (await db.projectDocument.findUnique({ where: { id: doc.id } })) ?? ctx.doc;
  }
  await saveProgress(ctx, "DONE", { status: "READY", error: null });
}
