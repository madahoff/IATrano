import { countTextTokens } from "@/lib/llm/tokens";

// Memory Retrieval : sélection des souvenirs à injecter dans un prompt, et détection des doublons. Fonctions pures.
//
// Les préférences (consignes durables) s'appliquent à toute demande : elles passent en premier.
// Les autres souvenirs ne sont injectés que s'ils partagent du vocabulaire significatif avec la demande courante
// (ou le résumé de la conversation) ; les décisions et contraintes importantes du projet courant sont toujours
// candidates. À pertinence égale priment l'importance, la fiabilité, le renforcement et la fraîcheur.
// Le tout dans la limite d'un budget de tokens. Seuls les souvenirs ACTIFS de la portée courante sont considérés :
// mémoire personnelle (projectId null) et mémoire du projet de la conversation, jamais celle d'un autre projet.

export type MemoryLike = {
  id: string;
  kind: "PREFERENCE" | "FACT" | "PROJECT" | "DECISION" | "CONSTRAINT" | "OBJECTIVE";
  project: string | null;
  content: string;
  updatedAt: Date;
  projectId?: string | null;
  status?: "ACTIVE" | "SUPERSEDED";
  certainty?: "CONFIRMED" | "STATED" | "UNCERTAIN";
  importance?: number;
  mentionCount?: number;
};

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

const TAGS: Record<MemoryLike["kind"], string> = { PREFERENCE: "Préférence", FACT: "Information", PROJECT: "Projet", DECISION: "Décision", CONSTRAINT: "Contrainte", OBJECTIVE: "Objectif" };
/** Longueur maximale d'un souvenir dans le prompt : les entrées volumineuses sont abrégées. */
export const MEMORY_LINE_MAX_CHARS = 400;

export function memoryLine(m: Pick<MemoryLike, "kind" | "project" | "content"> & { certainty?: MemoryLike["certainty"] }): string {
  const tag = m.kind === "PROJECT" ? `Projet ${m.project ?? ""}`.trim() : TAGS[m.kind];
  const content = m.content.length > MEMORY_LINE_MAX_CHARS ? `${m.content.slice(0, MEMORY_LINE_MAX_CHARS - 1).trimEnd()}…` : m.content;
  return `[${tag}] ${content}${m.certainty === "UNCERTAIN" ? " (non confirmé)" : ""}`;
}

/** Racine grossière : les formes d'un même mot partagent leurs 5 premières lettres (déploie / déployer / déploiement). */
export const root = (w: string) => (w.length >= 5 ? w.slice(0, 5).replace(/y/g, "i") : w);

const CERTAINTY_WEIGHT = { CONFIRMED: 3, STATED: 2, UNCERTAIN: 0 } as const;
const DAY = 86_400_000;

export function selectMemories<T extends MemoryLike>(memories: T[], query: string, budgetTokens: number, opts: { projectId?: string | null; now?: Date } = {}): T[] {
  const now = (opts.now ?? new Date()).getTime();
  const q = new Set(normalizeWords(query).map(root));
  const scored = memories
    .filter((m) => (m.status ?? "ACTIVE") === "ACTIVE" && (!m.projectId || m.projectId === opts.projectId))
    .map((m) => {
      const words = normalizeWords(`${m.project ?? ""} ${m.content}`).filter((w) => w !== "utilisateur" && w !== "projet");
      let hits = 0;
      for (const w of new Set(words.map(root))) if (q.has(w)) hits += w.length >= 5 ? 1.5 : 1;
      // Le nom du projet cité dans la demande suffit à rendre sa mémoire pertinente.
      if (m.kind === "PROJECT" && m.project && normalizeWords(m.project).every((w) => q.has(root(w)))) hits += 3;
      const importance = m.importance ?? 3;
      const quality = importance * 2 + CERTAINTY_WEIGHT[m.certainty ?? "CONFIRMED"] + Math.min(m.mentionCount ?? 1, 5) + (now - m.updatedAt.getTime() < 30 * DAY ? 2 : 0);
      let base = hits >= 1 ? 100 + hits * 10 : 0;
      if (m.kind === "PREFERENCE") base = 1000 + hits * 10;
      // Projet courant : ses décisions et contraintes importantes encadrent toute la conversation.
      else if (m.projectId && (m.kind === "CONSTRAINT" || m.kind === "DECISION") && importance >= 4) base = Math.max(base, 500);
      return { m, score: base ? base + quality : 0 };
    });
  const out: T[] = [];
  let used = 0;
  for (const { m } of scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || b.m.updatedAt.getTime() - a.m.updatedAt.getTime())) {
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

/** Part de la demande retrouvée dans un souvenir (désigner un souvenir à oublier : « oublie que j'utilise MySQL »). */
export function coverage(query: string, content: string): number {
  const q = new Set(normalizeWords(query).map(root));
  q.delete("utilis");
  if (q.size === 0) return 0;
  const c = new Set(normalizeWords(content).map(root));
  let hit = 0;
  for (const w of q) if (c.has(w)) hit++;
  return hit / q.size;
}
