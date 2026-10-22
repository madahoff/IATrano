import type { SearchHit } from "./search";

// Fonctions pures de la recherche hybride (testées sans base).

/** Reciprocal Rank Fusion : robuste à des échelles de scores hétérogènes (BM25 vs cosinus). */
export function rrf(lists: Array<{ name: keyof SearchHit["ranks"]; weight: number; ids: string[] }>, k = 60) {
  const scores = new Map<string, { score: number; ranks: SearchHit["ranks"] }>();
  for (const list of lists) {
    list.ids.forEach((id, i) => {
      const entry = scores.get(id) ?? { score: 0, ranks: {} };
      entry.score += list.weight / (k + i + 1);
      entry.ranks[list.name] = i + 1;
      scores.set(id, entry);
    });
  }
  return [...scores].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.score - a.score);
}

/** Expressions entre guillemets dans la requête (« … », "…"). */
export function quotedPhrases(query: string): string[] {
  return [...query.matchAll(/[«"“]\s*([^»"”]{2,120}?)\s*[»"”]/g)].map((m) => m[1].trim());
}

