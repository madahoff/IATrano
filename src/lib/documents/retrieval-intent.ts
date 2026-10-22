import { quotedPhrases } from "./search-utils";

// Analyse d'une question sans modèle : intention, pages et chapitres cités, notion recherchée (fonctions pures).

export type Intent = "summary" | "methods" | "compare" | "contradictions" | "occurrences" | "locate" | "lookup";

export type QuestionAnalysis = {
  intent: Intent;
  pageFrom: number | null;
  pageTo: number | null;
  /** Références de chapitres/sections citées (« chapitre 2 », « section 3.1 ») */
  chapters: string[];
  /** Notion dont on cherche toutes les occurrences */
  term: string | null;
};

const RX = {
  summary: /\b(r[ée]sum|synth[eè]s|vue d['’]ensemble|de quoi (parle|traite)|summar|overview|points? cl[ée]s)/i,
  methods: /\b(m[ée]thod|proc[ée]dur|processus|workflow|[ée]tapes|d[ée]marche|mode op[ée]ratoire|bonnes? pratiques?|checklist|comment (faire|proc[ée]der|r[ée]soudre)|fa[çc]ons? de travailler|technique)/i,
  compare: /\b(compar|diff[ée]ren|versus|\bvs\.?\b|par rapport [àa]|contrast)/i,
  contradictions: /\b(contradi|incoh[ée]ren|divergen|inconsisten|se contredi)/i,
  occurrences: /\b(toutes? les (occurrences|mentions|fois)|chaque (mention|occurrence)|partout o[uù]|occurrences?|o[uù] (est|sont) (mentionn|cit)[ée]e?s?)/i,
  locate: /\b(quelles? pages?|[àa] quelle page|dans quelles? (pages?|sections?|parties?)|[àa] quel moment|quand .{0,40}(expliqu|montr|abord|pr[ée]sent)|o[uù] .{0,30}(expliqu|d[ée]cri|trouv))/i,
};

export function analyzeQuestion(question: string): QuestionAnalysis {
  const q = question.trim();
  let intent: Intent = "lookup";
  if (RX.occurrences.test(q)) intent = "occurrences";
  else if (RX.contradictions.test(q)) intent = "contradictions";
  else if (RX.compare.test(q)) intent = "compare";
  // « Dans quelles pages cette procédure… » : la localisation prime sur le sujet (méthode, synthèse).
  else if (RX.locate.test(q)) intent = "locate";
  else if (RX.summary.test(q)) intent = "summary";
  else if (RX.methods.test(q)) intent = "methods";
  let pageFrom: number | null = null;
  let pageTo: number | null = null;
  const range = /\bpages?\s+(\d{1,5})\s*(?:[-–à]|au?|jusqu['’]?[àa])\s*(\d{1,5})/i.exec(q);
  const single = /\bpage\s+(\d{1,5})\b/i.exec(q);
  if (range) {
    pageFrom = Math.min(Number(range[1]), Number(range[2]));
    pageTo = Math.max(Number(range[1]), Number(range[2]));
  } else if (single) pageFrom = pageTo = Number(single[1]);
  const chapters = [...q.matchAll(/\b(chapitres?|chapters?|sections?|parties?|parts?|annexes?)\s+((?:\d{1,2}(?:\.\d{1,2})*|[IVXLC]{1,6})(?:\s*(?:,|et|and|&)\s*(?:\d{1,2}(?:\.\d{1,2})*|[IVXLC]{1,6}))*)/gi)].flatMap((m) =>
    m[2].split(/\s*(?:,|et|and|&)\s*/).map((n) => `${m[1].toLowerCase().replace(/s$/, "")} ${n}`),
  );
  const quoted = quotedPhrases(q);
  const notion = /(?:notion|terme|mot|concept|expression)\s+(?:de\s+|d['’]\s*|du\s+|«\s*)?["«“]?([^"»”?,.]{2,60})/i.exec(q);
  return { intent, pageFrom, pageTo, chapters: [...new Set(chapters)], term: quoted[0] ?? notion?.[1]?.trim() ?? null };
}

/** Motif PostgreSQL (~*) reconnaissant un chapitre ou une section dans le chemin « A › B ». */
export function chapterPattern(ref: string): string {
  const m = /^(\w+)\s+(.+)$/.exec(ref);
  const num = (m?.[2] ?? ref).trim().replace(/\./g, "\\.");
  const word = m?.[1] ?? "chapitre";
  const names = /^(chapitre|chapter)/.test(word) ? "chapitre|chapter|partie|part" : /^(partie|part)/.test(word) ? "partie|part|livre" : /^annexe/.test(word) ? "annexe|appendix" : "section|chapitre|chapter";
  return `(^|› )((${names})\\s+${num}([^0-9.]|$)|${num}(\\.|\\s|$))`;
}

export function compressPages(pages: number[]): string {
  const out: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (const p of [...pages.slice(1), Infinity]) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = p;
  }
  return out.filter((x) => x !== "undefined").join(", ");
}
