import { countTextTokens } from "@/lib/llm/tokens";

// Sélection des souvenirs à injecter dans un prompt, et détection des doublons. Fonctions pures.
//
// Les préférences (consignes durables) s'appliquent à toute demande : elles passent en premier.
// Les faits et les mémoires de projet ne sont injectés que s'ils partagent du vocabulaire significatif
// avec la demande courante (ou le résumé de la conversation), dans la limite d'un budget de tokens.

export type MemoryLike = { id: string; kind: "PREFERENCE" | "FACT" | "PROJECT"; project: string | null; content: string; updatedAt: Date };

const STOPWORDS = new Set(
  (
    "le la les un une des du de d l au aux et ou mais donc or ni car que qui quoi dont où ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs " +
    "je tu il elle on nous vous ils elles me te se moi toi lui eux y en ne pas plus moins très tout tous toute toutes est sont être avoir ai as a avons avez ont fait faire " +
    "pour par sur sous dans avec sans chez entre vers comme si alors aussi bien encore déjà peut veux voudrais peux dois quel quelle quels quelles comment pourquoi quand " +
    "the a an and or of to in on for with is are be it this that what how why when can you your my me i we our do does please merci bonjour salut svp stp"
  ).split(" "),
);

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(es|s|x)$/, "") : w));
}

export function similarity(a: string, b: string): number {
  const A = new Set(normalizeWords(a));
  const B = new Set(normalizeWords(b));
  if (A.size === 0 || B.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function findDuplicate<T extends { content: string }>(content: string, existing: T[], threshold = 0.75): T | null {
  let best: T | null = null;
  let bestScore = threshold;
  for (const m of existing) {
    const s = similarity(content, m.content);
    if (s >= bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}

export function memoryLine(m: Pick<MemoryLike, "kind" | "project" | "content">): string {
  const tag = m.kind === "PREFERENCE" ? "Préférence" : m.kind === "PROJECT" ? `Projet ${m.project ?? ""}`.trim() : "Information";
  return `[${tag}] ${m.content}`;
}

/** Racine grossière : les formes d'un même mot partagent leurs 5 premières lettres (déploie / déployer / déploiement). */
const root = (w: string) => (w.length >= 5 ? w.slice(0, 5).replace(/y/g, "i") : w);

export function selectMemories<T extends MemoryLike>(memories: T[], query: string, budgetTokens: number): T[] {
  const q = new Set(normalizeWords(query).map(root));
  const scored = memories.map((m) => {
    if (m.kind === "PREFERENCE") return { m, score: 1000 };
    const words = normalizeWords(`${m.project ?? ""} ${m.content}`).filter((w) => w !== "utilisateur");
    let hits = 0;
    for (const w of new Set(words.map(root))) if (q.has(w)) hits += w.length >= 5 ? 1.5 : 1;
    // Le nom du projet cité dans la demande suffit à rendre sa mémoire pertinente.
    if (m.kind === "PROJECT" && m.project && normalizeWords(m.project).every((w) => q.has(root(w)))) hits += 3;
    return { m, score: hits };
  });
  const out: T[] = [];
  let used = 0;
  for (const { m } of scored
    .filter((s) => s.score >= 1)
    .sort((a, b) => b.score - a.score || b.m.updatedAt.getTime() - a.m.updatedAt.getTime())) {
    const cost = countTextTokens(memoryLine(m)) + 2;
    if (used + cost > budgetTokens) continue;
    out.push(m);
    used += cost;
  }
  return out;
}

/** Budget réservé à la mémoire dans le prompt : 6 % de la capacité, entre 96 et 600 tokens. */
export function memoryBudget(capacity: number) {
  return Math.max(96, Math.min(600, Math.floor(capacity * 0.06)));
}
