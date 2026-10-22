import "server-only";
import { db } from "@/lib/db";
import { getOwnedProject } from "@/lib/projects/service";
import { chapterPattern } from "./retrieval";
import { findOccurrences, hybridSearch, snippetAround, exactSearch, type SearchFilters } from "./search";
import type { DocumentKindName, SegmentKind } from "./types";

// Recherche de passages depuis l'interface (onglet « Rechercher ») : mêmes index que le chat, résultats
// localisés (document, page, section, horodatage) et liens vers le passage original.

export type ExploreResult = {
  mode: "hybrid" | "exact" | "occurrences";
  total: number;
  occurrences: number | null;
  semantic: boolean;
  semanticError: string | null;
  durationMs: number;
  results: Array<{
    id: string;
    documentId: string;
    documentName: string;
    kind: DocumentKindName;
    page: number | null;
    pageEnd: number | null;
    section: string | null;
    type: SegmentKind;
    startMs: number | null;
    endMs: number | null;
    snippet: string;
    score: number;
    ranks: Record<string, number>;
    occurrences?: number;
  }>;
};

export async function searchProjectDocuments(
  userId: string,
  projectId: string,
  input: { q: string; mode: ExploreResult["mode"]; documentIds: string[]; pageFrom: number | null; pageTo: number | null; section: string | null; types: SegmentKind[] },
): Promise<ExploreResult> {
  await getOwnedProject(userId, projectId);
  const started = Date.now();
  const docs = await db.projectDocument.findMany({ where: { projectId, status: "READY", ...(input.documentIds.length ? { id: { in: input.documentIds } } : {}) }, select: { id: true, name: true, kind: true } });
  const meta = new Map(docs.map((d) => [d.id, d]));
  const empty: ExploreResult = { mode: input.mode, total: 0, occurrences: null, semantic: false, semanticError: null, durationMs: 0, results: [] };
  if (!docs.length) return empty;
  const section = input.section ? (/^(chapitre|chapter|section|partie|part|annexe)\s+\S+$/i.test(input.section) ? chapterPattern(input.section.toLowerCase()) : input.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : null;
  const filters: SearchFilters = { documentIds: docs.map((d) => d.id), pageFrom: input.pageFrom, pageTo: input.pageTo, sectionPattern: section, types: input.types.length ? input.types : null };
  const terms = input.q.replace(/[«»"“”]/g, "").split(/\s+/).filter((w) => w.length > 2);
  const shape = (r: { id: string; documentId: string; content: string; page: number | null; pageEnd: number | null; sectionPath: string[]; type: SegmentKind; startMs: number | null; endMs: number | null }, score: number, ranks: Record<string, number>, occurrences?: number) => ({
    id: r.id,
    documentId: r.documentId,
    documentName: meta.get(r.documentId)?.name ?? "document",
    kind: (meta.get(r.documentId)?.kind ?? "TEXT") as DocumentKindName,
    page: r.page,
    pageEnd: r.pageEnd,
    section: r.sectionPath.join(" › ") || null,
    type: r.type,
    startMs: r.startMs,
    endMs: r.endMs,
    snippet: snippetAround(r.content, input.mode === "hybrid" ? terms : [input.q.replace(/[«»"“”]/g, "")], 360),
    score,
    ranks,
    occurrences,
  });
  if (input.mode === "occurrences" || input.mode === "exact") {
    const phrase = input.q.replace(/[«»"“”]/g, "").trim();
    if (input.mode === "exact") {
      const ids = await exactSearch(phrase, filters, 300);
      const rows = await db.projectDocumentChunk.findMany({ where: { id: { in: ids.map((i) => i.id) } }, orderBy: [{ documentId: "asc" }, { ordinal: "asc" }] });
      const count = new Map(ids.map((i) => [i.id, i.occurrences]));
      return { ...empty, total: rows.length, occurrences: ids.reduce((n, i) => n + i.occurrences, 0), durationMs: Date.now() - started, results: rows.map((r) => shape({ ...r, type: r.type as SegmentKind }, 1, {}, count.get(r.id))) };
    }
    const occ = await findOccurrences(phrase, filters, 600);
    return { ...empty, mode: "occurrences", total: occ.rows.length, occurrences: occ.rows.reduce((n, r) => n + r.occurrences, 0), durationMs: Date.now() - started, results: occ.rows.map((r) => shape(r, 1, {}, r.occurrences)) };
  }
  const r = await hybridSearch(input.q, filters, { limit: 30 });
  return { ...empty, total: r.hits.length, semantic: r.semanticUsed, semanticError: r.semanticError, durationMs: Date.now() - started, results: r.hits.map((h) => shape(h, h.score, h.ranks as Record<string, number>)) };
}
