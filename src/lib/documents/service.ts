import "server-only";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import { getOwnedProject } from "@/lib/projects/service";
import { detectFormat, safeDisplayName } from "./formats";
import { discardTemp, moveIntoPlace, receiveStream, removeDocumentFiles } from "./storage";
import { getDocumentSettings } from "./settings";
import { STAGES, type Stage } from "./pipeline";
import { abortDocumentJobs, nudgeWorker } from "./worker";
import { dropVectorCache } from "./search";
import type { DocumentKindName, DocumentProgress } from "./types";

// Bibliothèque documentaire d'un projet : import (flux → disque, empreinte, déduplication, versions),
// file de traitement, consultation, retraitement et suppression cohérente de tout ce qui en dérive.
// Toutes les fonctions vérifient que le projet appartient à l'utilisateur.

export const MAX_DOCUMENTS_PER_PROJECT = 500;

export type DocumentListItem = {
  id: string;
  name: string;
  kind: DocumentKindName;
  mimeType: string;
  sizeBytes: number;
  status: string;
  stage: string;
  error: string | null;
  version: number;
  unitCount: number | null;
  progress: DocumentProgress;
  warnings: string[];
  segments: number;
  createdAt: string;
  updatedAt: string;
  indexedAt: string | null;
  analyzedAt: string | null;
  job: { status: string; attempts: number; error: string | null } | null;
};

const listSelect = {
  id: true,
  name: true,
  kind: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  stage: true,
  error: true,
  version: true,
  unitCount: true,
  progress: true,
  warnings: true,
  createdAt: true,
  updatedAt: true,
  indexedAt: true,
  analyzedAt: true,
  _count: { select: { chunks: true } },
  jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, attempts: true, error: true } },
} satisfies Prisma.ProjectDocumentSelect;

function toListItem(d: Prisma.ProjectDocumentGetPayload<{ select: typeof listSelect }>): DocumentListItem {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind as DocumentKindName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    status: d.status,
    stage: d.stage,
    error: d.error,
    version: d.version,
    unitCount: d.unitCount,
    progress: (d.progress ?? {}) as DocumentProgress,
    warnings: d.warnings,
    segments: d._count.chunks,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    indexedAt: d.indexedAt?.toISOString() ?? null,
    analyzedAt: d.analyzedAt?.toISOString() ?? null,
    job: d.jobs[0] ?? null,
  };
}

export async function listDocuments(userId: string, projectId: string): Promise<DocumentListItem[]> {
  await getOwnedProject(userId, projectId);
  const docs = await db.projectDocument.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, select: listSelect });
  return docs.map(toListItem);
}

export async function getOwnedDocument(userId: string, projectId: string, documentId: string) {
  await getOwnedProject(userId, projectId);
  const doc = await db.projectDocument.findFirst({ where: { id: documentId, projectId } });
  if (!doc) throw notFound("Document introuvable.");
  return doc;
}

async function enqueue(documentId: string, stages: Stage[] = []) {
  // Un seul traitement actif par document : les précédents sont annulés.
  const previous = await db.documentJob.findMany({ where: { documentId, status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } });
  if (previous.length) {
    await db.documentJob.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { status: "CANCELLED", finishedAt: new Date(), lockedAt: null } });
    abortDocumentJobs(previous.map((p) => p.id));
  }
  const job = await db.documentJob.create({ data: { documentId, stages } });
  nudgeWorker();
  return job;
}

export type ImportResult = { document: DocumentListItem; outcome: "created" | "duplicate" | "new_version" };

/**
 * Importe un fichier depuis un flux (jamais chargé entièrement en mémoire).
 * - même contenu déjà présent dans le projet : aucun retraitement (outcome « duplicate ») ;
 * - `replaceId` : nouvelle version d'un document existant (index et synthèses actualisés, analyses des sections
 *   inchangées réutilisées).
 */
export async function importDocument(userId: string, projectId: string, input: { name: string; body: ReadableStream<Uint8Array> | Readable; replaceId?: string | null }): Promise<ImportResult> {
  const project = await getOwnedProject(userId, projectId);
  if (!project.documentsEnabled) throw badRequest("La bibliothèque documentaire est désactivée pour ce projet.");
  const settings = await getDocumentSettings();
  const name = safeDisplayName(input.name);
  const replacing = input.replaceId ? await db.projectDocument.findFirst({ where: { id: input.replaceId, projectId } }) : null;
  if (input.replaceId && !replacing) throw notFound("Document à remplacer introuvable.");
  if (!replacing && (await db.projectDocument.count({ where: { projectId } })) >= MAX_DOCUMENTS_PER_PROJECT) throw badRequest(`Limite de ${MAX_DOCUMENTS_PER_PROJECT} documents par projet atteinte.`);

  const received = await receiveStream(input.body, settings.maxFileMb * 1024 * 1024);
  try {
    const format = detectFormat(name, received.head);
    if ("error" in format) throw badRequest(format.error, "unsupported_document");
    if (replacing && replacing.kind !== format.kind) throw badRequest("La nouvelle version doit être du même type de fichier que l'original.");

    const duplicate = await db.projectDocument.findFirst({ where: { projectId, checksum: received.checksum }, select: listSelect });
    if (duplicate) {
      await discardTemp(received.tempPath);
      return { document: toListItem(duplicate), outcome: "duplicate" };
    }

    if (replacing) {
      const version = replacing.version + 1;
      const storagePath = path.join(projectId, replacing.id, `original-v${version}${format.ext}`);
      await moveIntoPlace(received.tempPath, storagePath);
      await db.$transaction([
        db.documentVersion.create({ data: { documentId: replacing.id, version, name, checksum: received.checksum, sizeBytes: received.size, storagePath } }),
        db.projectDocument.update({
          where: { id: replacing.id },
          data: { name, mimeType: format.mime, sizeBytes: received.size, checksum: received.checksum, version, storagePath, status: replacing.indexedAt ? "READY" : "PENDING", stage: "QUEUED", error: null, warnings: [], progress: {} },
        }),
      ]);
      await enqueue(replacing.id);
      const doc = await db.projectDocument.findUniqueOrThrow({ where: { id: replacing.id }, select: listSelect });
      return { document: toListItem(doc), outcome: "new_version" };
    }

    const created = await db.projectDocument.create({
      data: { projectId, name, mimeType: format.mime, kind: format.kind, sizeBytes: received.size, checksum: received.checksum, status: "PENDING", stage: "QUEUED" },
    });
    const storagePath = path.join(projectId, created.id, `original-v1${format.ext}`);
    await moveIntoPlace(received.tempPath, storagePath);
    await db.$transaction([
      db.projectDocument.update({ where: { id: created.id }, data: { storagePath } }),
      db.documentVersion.create({ data: { documentId: created.id, version: 1, name, checksum: received.checksum, sizeBytes: received.size, storagePath } }),
    ]);
    await enqueue(created.id);
    const doc = await db.projectDocument.findUniqueOrThrow({ where: { id: created.id }, select: listSelect });
    return { document: toListItem(doc), outcome: "created" };
  } catch (err) {
    await discardTemp(received.tempPath);
    throw err;
  }
}

/** Relance le traitement : complet, ou à partir d'une étape (ex. « ANALYZE » pour refaire synthèses et méthodes). */
export async function reprocessDocument(userId: string, projectId: string, documentId: string, from: Stage = "EXTRACT") {
  const doc = await getOwnedDocument(userId, projectId, documentId);
  if (!STAGES.includes(from)) throw badRequest("Étape inconnue.");
  if (from === "ANALYZE") await db.documentSection.updateMany({ where: { documentId, analysisStatus: { in: ["FAILED", "SKIPPED"] } }, data: { analysisStatus: "PENDING" } });
  if (from === "OCR") await db.documentPage.updateMany({ where: { documentId, status: { in: ["FAILED", "SKIPPED"] } }, data: { error: (await import("./pipeline")).PENDING_MARK } });
  const stages = STAGES.slice(STAGES.indexOf(from));
  await db.projectDocument.update({ where: { id: doc.id }, data: { stage: "QUEUED", error: null, status: doc.indexedAt ? "READY" : "PENDING" } });
  return enqueue(doc.id, from === "EXTRACT" ? [] : [...stages]);
}

/**
 * Suppression : fichiers (original, pages rendues, images clés, audio), pages, segments et index, sections,
 * connaissances, versions, traitements, et souvenirs de projet issus du document. Les traces de récupération
 * des réponses passées conservent seulement les métadonnées déjà affichées (nom, page, extrait court).
 */
export async function deleteDocument(userId: string, projectId: string, documentId: string) {
  const project = await getOwnedProject(userId, projectId);
  const doc = await db.projectDocument.findFirst({ where: { id: documentId, projectId }, select: { id: true } });
  if (!doc) throw notFound("Document introuvable.");
  const jobs = await db.documentJob.findMany({ where: { documentId, status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } });
  abortDocumentJobs(jobs.map((j) => j.id));
  await db.$transaction([
    db.memory.deleteMany({ where: { userId: project.userId, projectId, source: "DOCUMENT", sourceDocumentId: documentId } }),
    db.projectDocument.delete({ where: { id: documentId } }),
  ]);
  dropVectorCache(documentId);
  await removeDocumentFiles(projectId, documentId);
}

export async function getDocumentDetail(userId: string, projectId: string, documentId: string) {
  await getOwnedDocument(userId, projectId, documentId);
  const [doc, sections, insights, pageStats, versions, jobs, failedPages] = await Promise.all([
    db.projectDocument.findUniqueOrThrow({ where: { id: documentId }, select: { ...listSelect, metadata: true, language: true } }),
    db.documentSection.findMany({ where: { documentId }, orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true, level: true, title: true, path: true, pageStart: true, pageEnd: true, startMs: true, endMs: true, tokenCount: true, analysisStatus: true, analysis: true } }),
    db.documentInsight.findMany({ where: { documentId }, orderBy: [{ status: "asc" }, { kind: "asc" }, { createdAt: "asc" }], select: { id: true, kind: true, title: true, content: true, text: true, origin: true, sources: true, status: true, version: true, model: true, createdAt: true } }),
    db.documentPage.groupBy({ by: ["status", "method"], where: { documentId }, _count: { _all: true } }),
    db.documentVersion.findMany({ where: { documentId }, orderBy: { version: "desc" }, select: { version: true, name: true, sizeBytes: true, checksum: true, changes: true, createdAt: true } }),
    db.documentJob.findMany({ where: { documentId }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, stage: true, attempts: true, error: true, metrics: true, startedAt: true, finishedAt: true, createdAt: true } }),
    db.documentPage.findMany({ where: { documentId, status: { in: ["FAILED", "SKIPPED", "EMPTY", "PARTIAL"] } }, orderBy: { number: "asc" }, take: 500, select: { number: true, label: true, status: true, method: true, error: true, confidence: true } }),
  ]);
  return {
    document: { ...toListItem(doc), metadata: doc.metadata, language: doc.language },
    sections,
    insights,
    pageStats: pageStats.map((p) => ({ status: p.status, method: p.method, count: p._count._all })),
    issues: failedPages,
    versions,
    jobs,
  };
}

/** Carte de couverture : état de chaque unité (sans le texte). */
export async function listPages(userId: string, projectId: string, documentId: string) {
  await getOwnedDocument(userId, projectId, documentId);
  return db.documentPage.findMany({ where: { documentId }, orderBy: { number: "asc" }, select: { number: true, label: true, method: true, status: true, charCount: true, confidence: true, error: true, startMs: true, endMs: true, imagePath: true } });
}

/** Passage original : texte extrait d'une page (et de ses voisines si demandé), avec ses métadonnées. */
export async function getPage(userId: string, projectId: string, documentId: string, number: number) {
  const doc = await getOwnedDocument(userId, projectId, documentId);
  const page = await db.documentPage.findUnique({ where: { documentId_number: { documentId, number } } });
  if (!page) throw notFound("Page introuvable.");
  const sections = await db.documentSection.findMany({
    where: { documentId, pageStart: { lte: number }, OR: [{ pageEnd: { gte: number } }, { pageEnd: null }] },
    orderBy: { ordinal: "asc" },
    select: { path: true },
  });
  return {
    document: { id: doc.id, name: doc.name, kind: doc.kind, unitCount: doc.unitCount, hasOriginal: Boolean(doc.storagePath) },
    page: { number: page.number, label: page.label, method: page.method, status: page.status, confidence: page.confidence, error: page.error, text: page.text, visual: page.visual, startMs: page.startMs, endMs: page.endMs, hasImage: Boolean(page.imagePath) },
    section: sections.at(-1)?.path ?? null,
  };
}

export async function deleteInsight(userId: string, projectId: string, documentId: string, insightId: string) {
  await getOwnedDocument(userId, projectId, documentId);
  const r = await db.documentInsight.deleteMany({ where: { id: insightId, documentId } });
  if (!r.count) throw notFound("Connaissance introuvable.");
}

/** Documents interrogeables d'un projet appartenant à l'utilisateur (filtrés par une sélection éventuelle). */
export async function searchableDocuments(userId: string, projectId: string, only?: string[] | null) {
  const project = await db.project.findFirst({ where: { id: projectId, userId }, select: { id: true, documentsEnabled: true } });
  if (!project || !project.documentsEnabled) return [];
  return db.projectDocument.findMany({
    where: { projectId, status: "READY", ...(only?.length ? { id: { in: only } } : {}) },
    select: { id: true, name: true, kind: true, unitCount: true, analyzedAt: true, projectId: true, warnings: true },
  });
}
