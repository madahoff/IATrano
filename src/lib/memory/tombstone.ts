import { createHash } from "node:crypto";
import { normalizeWords, root } from "./select";

// Empreintes d'oubli : quand l'utilisateur supprime un souvenir, on conserve seulement des hachés de ses mots
// (aucun texte en clair). Une analyse encore en attente, portant sur un message ANTÉRIEUR à l'oubli,
// ne peut pas recréer ce souvenir. Fonctions pures.

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function fingerprint(content: string): string[] {
  return [...new Set(normalizeWords(content).filter((w) => w !== "utilisateur").map(root))].map(h).sort();
}

export function topicHash(topic: string | null | undefined): string | null {
  return topic ? h(`topic:${topic}`) : null;
}

/** Similarité (Jaccard) entre deux empreintes. */
export function fingerprintSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const B = new Set(b);
  const inter = a.filter((x) => B.has(x)).length;
  return inter / (a.length + b.length - inter);
}

export const TOMBSTONE_SIMILARITY = 0.6;
