import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getAppSettings } from "@/lib/settings/service";
import { dot, embedQuery, embeddingConfig, fromBytes, type EmbeddingConfig } from "./embeddings";
import { getDocumentSettings } from "./settings";
import type { SegmentKind } from "./types";
import { quotedPhrases, rrf } from "./search-utils";

export { quotedPhrases, rrf };

// Recherche hybride dans les segments d'un ensemble de documents (déjà autorisés par l'appelant) :
//  - lexicale : BM25 calculé en SQL sur l'index plein texte PostgreSQL (df par terme via l'index GIN,
//    tf tirée des positions du tsvector, longueur normalisée par la moyenne du périmètre) ;
//  - sémantique : similarité cosinus des embeddings (si un modèle est configuré) ;
//  - expressions exactes entre guillemets ;
// fusionnées par Reciprocal Rank Fusion, avec filtres (documents, pages, chapitre, type, période).

export type SearchFilters = {
  documentIds: string[];
  pageFrom?: number | null;
  pageTo?: number | null;
  /** Expression régulière (insensible à la casse) appliquée au chemin de section « A › B › C » */
  sectionPattern?: string | null;
  types?: SegmentKind[] | null;
  /** Documents importés dans cet intervalle */
  importedAfter?: Date | null;
  importedBefore?: Date | null;
  timeFromMs?: number | null;
  timeToMs?: number | null;
};

export type SearchHit = {
  id: string;
  documentId: string;
  ordinal: number;
  content: string;
  page: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  type: SegmentKind;
  startMs: number | null;
  endMs: number | null;
  score: number;
  /** Rang dans chaque liste (transparence du classement) */
  ranks: { lexical?: number; semantic?: number; exact?: number; expansion?: number };
};

function filterSql(f: SearchFilters, alias = "c"): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`${Prisma.raw(alias)}."documentId" = ANY(${f.documentIds}::text[])`];
  if (f.pageFrom != null) parts.push(Prisma.sql`COALESCE(${Prisma.raw(alias)}."pageEnd", ${Prisma.raw(alias)}."page") >= ${f.pageFrom}`);
  if (f.pageTo != null) parts.push(Prisma.sql`${Prisma.raw(alias)}."page" <= ${f.pageTo}`);
  if (f.sectionPattern) parts.push(Prisma.sql`array_to_string(${Prisma.raw(alias)}."sectionPath", ' › ') ~* ${f.sectionPattern}`);
  if (f.types?.length) parts.push(Prisma.sql`${Prisma.raw(alias)}."type"::text = ANY(${f.types}::text[])`);
  if (f.timeFromMs != null) parts.push(Prisma.sql`COALESCE(${Prisma.raw(alias)}."endMs", ${Prisma.raw(alias)}."startMs") >= ${f.timeFromMs}`);
  if (f.timeToMs != null) parts.push(Prisma.sql`${Prisma.raw(alias)}."startMs" <= ${f.timeToMs}`);
  if (f.importedAfter || f.importedBefore) {
    const after = f.importedAfter ?? new Date(0);
    const before = f.importedBefore ?? new Date(8.64e15);
    parts.push(Prisma.sql`${Prisma.raw(alias)}."documentId" IN (SELECT id FROM "ProjectDocument" WHERE "createdAt" BETWEEN ${after} AND ${before})`);
  }
  return Prisma.join(parts, " AND ");
}

/** BM25 (k1 = 1,2 ; b = 0,75). Les lexèmes de la requête sont produits par les configurations français, anglais et simple. */
export async function lexicalSearch(query: string, f: SearchFilters, limit = 50): Promise<Array<{ id: string; score: number }>> {
  if (!query.trim() || !f.documentIds.length) return [];
  return db.$queryRaw<Array<{ id: string; score: number }>>`
    WITH q AS (
      SELECT DISTINCT lexeme FROM (
        SELECT (unnest(to_tsvector('french', iatrano_unaccent(${query})))).lexeme
        UNION ALL SELECT (unnest(to_tsvector('english', iatrano_unaccent(${query})))).lexeme
        UNION ALL SELECT (unnest(to_tsvector('simple', iatrano_unaccent(${query})))).lexeme
      ) t WHERE length(lexeme) > 1
    ),
    scope AS (SELECT c.id, c.tsv, c."lexCount" FROM "ProjectDocumentChunk" c WHERE ${filterSql(f)} AND c.tsv IS NOT NULL),
    stats AS (SELECT count(*)::float8 AS n, GREATEST(avg("lexCount"), 1)::float8 AS avgdl FROM scope),
    anyq AS (SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS tq FROM q),
    cand AS (SELECT s.* FROM scope s, anyq WHERE anyq.tq IS NOT NULL AND s.tsv @@ anyq.tq),
    df AS (SELECT q.lexeme, (SELECT count(*) FROM cand c WHERE c.tsv @@ quote_literal(q.lexeme)::tsquery)::float8 AS df FROM q),
    tf AS (
      SELECT c.id, u.lexeme, COALESCE(array_length(u.positions, 1), 1)::float8 AS tf, GREATEST(c."lexCount", 1)::float8 AS dl
      FROM cand c, unnest(c.tsv) u WHERE u.lexeme IN (SELECT lexeme FROM q)
    )
    SELECT tf.id, SUM(ln(1 + (stats.n - df.df + 0.5) / (df.df + 0.5)) * tf.tf * 2.2 / (tf.tf + 1.2 * (0.25 + 0.75 * tf.dl / stats.avgdl)))::float8 AS score
    FROM tf JOIN df USING (lexeme), stats
    WHERE df.df > 0
    GROUP BY tf.id ORDER BY score DESC LIMIT ${limit}`;
}

/** Segments contenant une expression exacte (insensible à la casse et aux accents). */
export async function exactSearch(phrase: string, f: SearchFilters, limit = 200): Promise<Array<{ id: string; occurrences: number }>> {
  const p = phrase.trim();
  if (p.length < 2 || !f.documentIds.length) return [];
  return db.$queryRaw<Array<{ id: string; occurrences: number }>>`
    SELECT c.id, ((length(iatrano_unaccent(lower(c.content))) - length(replace(iatrano_unaccent(lower(c.content)), iatrano_unaccent(lower(${p})), ''))) / GREATEST(length(${p}), 1))::int AS occurrences
    FROM "ProjectDocumentChunk" c
    WHERE ${filterSql(f)} AND strpos(iatrano_unaccent(lower(c.content)), iatrano_unaccent(lower(${p}))) > 0
    ORDER BY c."documentId", c.ordinal LIMIT ${limit}`;
}

// --- Vecteurs : chargés par document et gardés en mémoire (invalidés à chaque réindexation via indexedAt).
type VectorSet = { key: string; ids: string[]; vecs: Float32Array[] };
const g = globalThis as unknown as { __iatranoVectors?: Map<string, VectorSet> };
const vectorCache = (g.__iatranoVectors ??= new Map());
const MAX_CACHED_VECTORS = 300_000;

async function documentVectors(documentId: string, model: string): Promise<VectorSet> {
  const doc = await db.projectDocument.findUnique({ where: { id: documentId }, select: { indexedAt: true, version: true } });
  const key = `${model}|${doc?.version}|${doc?.indexedAt?.getTime()}`;
  const hit = vectorCache.get(documentId);
  if (hit && hit.key === key) {
    vectorCache.delete(documentId);
    vectorCache.set(documentId, hit);
    return hit;
  }
  const rows = await db.projectDocumentChunk.findMany({ where: { documentId, embeddingModel: model, embedding: { not: null } }, select: { id: true, embedding: true } });
  const set: VectorSet = { key, ids: rows.map((r) => r.id), vecs: rows.map((r) => fromBytes(r.embedding!)) };
  vectorCache.set(documentId, set);
  let total = [...vectorCache.values()].reduce((n, s) => n + s.ids.length, 0);
  for (const [k, s] of vectorCache) {
    if (total <= MAX_CACHED_VECTORS) break;
    if (k === documentId) continue;
    vectorCache.delete(k);
    total -= s.ids.length;
  }
  return set;
}

export function dropVectorCache(documentId: string) {
  vectorCache.delete(documentId);
}

export async function semanticSearch(cfg: EmbeddingConfig, query: string, f: SearchFilters, limit = 50, signal?: AbortSignal): Promise<Array<{ id: string; score: number }>> {
  if (!query.trim() || !f.documentIds.length) return [];
  const q = await embedQuery(cfg, query, signal);
  const hasFilters = f.pageFrom != null || f.pageTo != null || f.sectionPattern || f.types?.length || f.timeFromMs != null || f.timeToMs != null || f.importedAfter || f.importedBefore;
  const allowed = hasFilters ? new Set((await db.$queryRaw<Array<{ id: string }>>`SELECT c.id FROM "ProjectDocumentChunk" c WHERE ${filterSql(f)}`).map((r) => r.id)) : null;
  const scored: Array<{ id: string; score: number }> = [];
  for (const documentId of f.documentIds) {
    const set = await documentVectors(documentId, cfg.model);
    for (let i = 0; i < set.ids.length; i++) {
      if (allowed && !allowed.has(set.ids[i])) continue;
      scored.push({ id: set.ids[i], score: dot(q, set.vecs[i]) });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export type HybridOptions = { limit?: number; expansions?: string[]; semantic?: boolean; signal?: AbortSignal };
export type HybridResult = { hits: SearchHit[]; semanticUsed: boolean; semanticError: string | null; embeddingModel: string | null };

export async function hybridSearch(query: string, f: SearchFilters, opts: HybridOptions = {}): Promise<HybridResult> {
  const limit = opts.limit ?? 20;
  const [app, docs] = await Promise.all([getAppSettings(), getDocumentSettings()]);
  const cfg = opts.semantic === false ? null : embeddingConfig(app, docs);
  const phrases = quotedPhrases(query);
  let semanticError: string | null = null;
  const [lexical, semantic, exact, expansion] = await Promise.all([
    lexicalSearch(query, f, 60),
    cfg
      ? semanticSearch(cfg, query, f, 60, opts.signal).catch((err: unknown) => {
          semanticError = err instanceof Error ? err.message : String(err);
          return [];
        })
      : Promise.resolve([]),
    phrases.length ? Promise.all(phrases.map((p) => exactSearch(p, f, 60))).then((r) => r.flat().sort((a, b) => b.occurrences - a.occurrences)) : Promise.resolve([]),
    opts.expansions?.length ? lexicalSearch(opts.expansions.join(" "), f, 40) : Promise.resolve([]),
  ]);
  const fused = rrf([
    { name: "lexical", weight: 1, ids: lexical.map((r) => r.id) },
    { name: "semantic", weight: 1, ids: semantic.filter((r) => r.score > 0.2).map((r) => r.id) },
    { name: "exact", weight: 1.5, ids: exact.map((r) => r.id) },
    { name: "expansion", weight: 0.5, ids: expansion.map((r) => r.id) },
  ]).slice(0, limit);
  const rows = fused.length
    ? await db.projectDocumentChunk.findMany({
        where: { id: { in: fused.map((x) => x.id) } },
        select: { id: true, documentId: true, ordinal: true, content: true, page: true, pageEnd: true, sectionPath: true, type: true, startMs: true, endMs: true },
      })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hits = fused.flatMap((x) => {
    const r = byId.get(x.id);
    return r ? [{ ...r, type: r.type as SegmentKind, score: x.score, ranks: x.ranks }] : [];
  });
  return { hits, semanticUsed: Boolean(cfg) && !semanticError, semanticError, embeddingModel: cfg?.model ?? null };
}

/** Toutes les occurrences d'une notion (expression exacte, puis lexèmes) : couverture complète, regroupée par page. */
export async function findOccurrences(term: string, f: SearchFilters, limit = 400) {
  const exact = await exactSearch(term, f, limit);
  const ids = exact.length ? exact.map((e) => e.id) : (await lexicalSearch(term, f, limit)).map((e) => e.id);
  const rows = ids.length
    ? await db.projectDocumentChunk.findMany({ where: { id: { in: ids } }, orderBy: [{ documentId: "asc" }, { ordinal: "asc" }], select: { id: true, documentId: true, ordinal: true, content: true, page: true, pageEnd: true, sectionPath: true, type: true, startMs: true, endMs: true } })
    : [];
  const counts = new Map(exact.map((e) => [e.id, e.occurrences]));
  return { mode: exact.length ? ("exact" as const) : ("lexical" as const), rows: rows.map((r) => ({ ...r, type: r.type as SegmentKind, occurrences: counts.get(r.id) ?? 1 })) };
}

/** Extrait centré sur la première occurrence d'un terme (insensible aux accents). */
export function snippetAround(content: string, terms: string[], width = 320): string {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const folded = fold(content);
  let at = -1;
  for (const t of terms) {
    const i = folded.indexOf(fold(t));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || content.length <= width) return content.slice(0, width) + (content.length > width ? "…" : "");
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? "…" : ""}${content.slice(start, start + width)}${start + width < content.length ? "…" : ""}`;
}
