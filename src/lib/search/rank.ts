// Segmentation des documents et sélection des passages pertinents (BM25 + ajustements mesurables).
// Volontairement lexical : rapide, déterministe, sans service supplémentaire. Une recherche vectorielle
// pourra être ajoutée derrière la même interface si elle apporte un gain démontré.
import { clip, jaccard, shingles, terms } from "./text";

export type Doc = {
  key: string;
  title: string;
  publishedAt: string | null;
  primary: boolean;
  /** "snippet" : seul l'extrait du moteur est disponible (page inaccessible). */
  content: "full" | "partial" | "snippet";
  blocks: Array<{ heading: string | null; text: string }>;
};

export type Chunk = { docKey: string; index: number; heading: string | null; text: string };

const TARGET = 700;
const MAX = 1100;
const OVERLAP = 160;

/** Regroupe les blocs d'un document en segments d'environ 700 caractères, avec un léger chevauchement. */
export function chunkDoc(doc: Doc): Chunk[] {
  const chunks: Chunk[] = [];
  let buf = "";
  let heading: string | null = null;
  const push = () => {
    const text = buf.trim();
    if (text) chunks.push({ docKey: doc.key, index: chunks.length, heading, text });
  };
  for (const block of doc.blocks) {
    const pieces = block.text.length > MAX ? splitLong(block.text) : [block.text];
    for (const piece of pieces) {
      // Nouvelle section : on ne mélange pas deux sujets dans un même segment (sauf fragments minuscules).
      if (block.heading !== heading && buf.length > 80) {
        push();
        buf = "";
      }
      if (!buf) heading = block.heading;
      if (buf.length + piece.length > MAX && buf) {
        push();
        // Chevauchement : la fin du segment précédent garde le fil du propos.
        const tail = buf.slice(-OVERLAP);
        const cut = tail.search(/[.!?]\s/);
        buf = cut >= 0 ? tail.slice(cut + 2) : "";
        heading = block.heading;
      }
      buf += (buf ? "\n" : "") + piece;
      if (buf.length >= TARGET) {
        push();
        const tail = buf.slice(-OVERLAP);
        const cut = tail.search(/[.!?]\s/);
        buf = cut >= 0 ? tail.slice(cut + 2) : "";
      }
    }
  }
  if (buf.trim() && !chunks.some((c) => c.text.endsWith(buf.trim()))) push();
  return chunks;
}

function splitLong(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > TARGET && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
    while (cur.length > MAX) {
      out.push(cur.slice(0, MAX));
      cur = cur.slice(MAX);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type RankOptions = {
  timeSensitive: boolean;
  maxSources: number;
  perSource: number;
  charBudget: number;
  now?: number;
};

export type Selected = { docKey: string; passages: Array<{ text: string; heading: string | null; score: number; index: number }>; score: number };

export type RankResult = { selected: Selected[]; chunkCount: number; duplicates: number; relevant: number };

const K1 = 1.2;
const B = 0.75;

/** Classe tous les segments et retient les meilleurs dans la limite du budget de contexte. */
export function selectPassages(docs: Doc[], query: string, opts: RankOptions): RankResult {
  const qTerms = [...new Set(terms(query))];
  const docByKey = new Map(docs.map((d) => [d.key, d]));
  const chunks = docs.flatMap(chunkDoc);
  const tokenized = chunks.map((c) => terms(`${c.heading ?? ""} ${c.text}`));
  const avgLen = tokenized.reduce((n, t) => n + t.length, 0) / Math.max(1, tokenized.length);
  const df = new Map<string, number>();
  for (const toks of tokenized) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = chunks.length;
  const now = opts.now ?? Date.now();

  const scored = chunks.map((chunk, i) => {
    const toks = tokenized[i];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    let matched = 0;
    for (const q of qTerms) {
      const f = tf.get(q);
      if (!f) continue;
      matched++;
      const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks.length) / Math.max(1, avgLen))));
    }
    const doc = docByKey.get(chunk.docKey)!;
    // Couverture : un passage qui contient plusieurs termes distincts de la question vaut mieux qu'un terme répété.
    if (qTerms.length > 1) score *= 0.6 + (0.4 * matched) / qTerms.length;
    const titleTerms = new Set(terms(doc.title));
    const titleHits = qTerms.filter((q) => titleTerms.has(q)).length;
    score *= 1 + Math.min(0.3, titleHits * 0.08);
    if (doc.primary) score *= 1.12;
    if (doc.content === "snippet") score *= 0.6;
    if (opts.timeSensitive && doc.publishedAt) {
      const ageDays = (now - Date.parse(doc.publishedAt)) / 86_400_000;
      if (ageDays < 45) score *= 1.2;
      else if (ageDays < 365) score *= 1.05;
      else if (ageDays > 730) score *= 0.8;
    }
    return { chunk, score, matched };
  });

  const relevant = scored.filter((s) => s.score > 0 && s.matched > 0).sort((a, b) => b.score - a.score);
  const kept: typeof relevant = [];
  const keptShingles: Set<string>[] = [];
  const perDoc = new Map<string, number>();
  let duplicates = 0;
  let used = 0;
  for (const s of relevant) {
    const count = perDoc.get(s.chunk.docKey) ?? 0;
    if (count >= opts.perSource) continue;
    if (!perDoc.has(s.chunk.docKey) && perDoc.size >= opts.maxSources) continue;
    const sh = shingles(s.chunk.text);
    if (keptShingles.some((k) => jaccard(k, sh) > 0.5)) {
      duplicates++;
      continue;
    }
    const len = Math.min(s.chunk.text.length, MAX);
    if (used + len > opts.charBudget) {
      if (used > opts.charBudget * 0.7) break;
      continue;
    }
    kept.push(s);
    keptShingles.push(sh);
    perDoc.set(s.chunk.docKey, count + 1);
    used += len;
  }

  const groups = new Map<string, Selected>();
  for (const s of kept) {
    const g = groups.get(s.chunk.docKey) ?? { docKey: s.chunk.docKey, passages: [], score: 0 };
    g.passages.push({ text: clip(s.chunk.text, MAX), heading: s.chunk.heading, score: Math.round(s.score * 100) / 100, index: s.chunk.index });
    g.score = Math.max(g.score, s.score);
    groups.set(s.chunk.docKey, g);
  }
  // Passages d'une même source remis dans l'ordre du document pour préserver le sens.
  for (const g of groups.values()) g.passages.sort((a, b) => a.index - b.index);
  return {
    selected: [...groups.values()].sort((a, b) => b.score - a.score),
    chunkCount: chunks.length,
    duplicates,
    relevant: relevant.length,
  };
}
