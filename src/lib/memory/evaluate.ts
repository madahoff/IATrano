import { autoMemoryRejected, sensitivePersonalReason } from "./sensitive";
import type { MemoryCandidate } from "./types";

// Memory Evaluation : décide si une information candidate mérite d'être conservée. Fonction pure.
// Critères : sécurité (secrets toujours refusés), sensibilité (jamais automatique), durabilité (pas d'information
// datée « aujourd'hui »), utilité future (importance) et fiabilité (une hésitation reste une hypothèse, signalée
// comme « non confirmée » au modèle et moins prioritaire lors de la sélection).

const TRANSIENT =
  /(?<![\p{L}])(aujourd'hui|ce matin|ce soir|cet apr[èe]s-midi|cette nuit|demain|hier|tout [àa] l'heure|cette semaine|ce week-end|en ce moment|pour l'instant|l[àa] maintenant|pour cette (?:question|r[ée]ponse|fois)|juste pour (?:cette|ce)|today|tonight|tomorrow|right now|this time)(?![\p{L}])/iu;
const HEDGE = /(?<![\p{L}])(peut[- ][êe]tre|je pense|probablement|sans doute|envisage|songe [àa]|il se peut|pas s[ûu]r|h[ée]site|maybe|probably|might)(?![\p{L}])/iu;
const ADDITIVE = /(?<![\p{L}])(aussi|[ée]galement|en plus|de plus|also|as well)(?![\p{L}])/iu;

export const AUTO_MEMORY_MAX_CHARS = 300;
/** Score minimal (importance + bonus) pour qu'une information exprimée sans demande explicite soit retenue. */
export const ACCEPT_SCORE = 3;

export type Evaluation =
  | { ok: true; candidate: MemoryCandidate; score: number }
  // silent : refus ordinaire (information ponctuelle) dont l'utilisateur n'a pas à être averti
  | { ok: false; reason: string; silent: boolean };

/** Une information « aussi / également » s'ajoute aux souvenirs du même sujet au lieu de les remplacer. */
export const isAdditive = (text: string) => ADDITIVE.test(text);

/** Préférences et décisions sont exclusives par sujet ; certains faits aussi (prénom). */
export function isExclusive(kind: MemoryCandidate["kind"], topic: string | null) {
  if (!topic) return false;
  return kind === "PREFERENCE" || kind === "DECISION" || topic === "prenom";
}

export function evaluateCandidate(c: MemoryCandidate, ctx: { explicit: boolean }): Evaluation {
  const content = c.content.replace(/\s+/g, " ").trim();
  const evidence = c.evidence ?? "";
  const secret = autoMemoryRejected(content) ?? (evidence ? autoMemoryRejected(evidence) : null);
  if (secret) return { ok: false, reason: secret, silent: false };
  if (content.length < 8) return { ok: false, reason: "Information trop courte.", silent: true };
  if (!ctx.explicit) {
    const personal = sensitivePersonalReason(`${content} ${evidence}`);
    if (personal) return { ok: false, reason: personal, silent: false };
    if (TRANSIENT.test(evidence || content)) return { ok: false, reason: "Information ponctuelle.", silent: true };
  }
  const certainty = ctx.explicit ? "CONFIRMED" : c.certainty === "UNCERTAIN" || HEDGE.test(evidence) ? "UNCERTAIN" : c.certainty;
  const importance = Math.min(5, Math.max(1, Math.round(c.importance)));
  const score = importance + (ctx.explicit ? 3 : 0) + (["PREFERENCE", "DECISION", "CONSTRAINT"].includes(c.kind) ? 1 : 0);
  if (score < ACCEPT_SCORE) return { ok: false, reason: "Information jugée sans utilité durable.", silent: true };
  const clipped = content.length > AUTO_MEMORY_MAX_CHARS ? `${content.slice(0, AUTO_MEMORY_MAX_CHARS - 1).trimEnd()}…` : content;
  return { ok: true, candidate: { ...c, content: clipped, certainty, importance: ctx.explicit ? Math.max(importance, 4) : importance }, score };
}
