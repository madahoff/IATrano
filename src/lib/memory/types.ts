// Types de la mémoire partagés entre le serveur et le navigateur — ne doit importer aucun module serveur.

export const MEMORY_KINDS = ["PREFERENCE", "FACT", "PROJECT", "DECISION", "CONSTRAINT", "OBJECTIVE"] as const;
export type MemoryKindValue = (typeof MEMORY_KINDS)[number];
export type MemoryCertaintyValue = "CONFIRMED" | "STATED" | "UNCERTAIN";
export type MemoryScope = "personal" | "project";

/** Information candidate à la mémorisation, avant évaluation. */
export type MemoryCandidate = {
  kind: MemoryKindValue;
  scope: MemoryScope;
  /** Nom de projet pour une mémoire personnelle de type PROJECT (hors espace projet). */
  project: string | null;
  topic: string | null;
  content: string;
  /** Extrait du message de l'utilisateur qui justifie l'information (preuve, jamais une supposition). */
  evidence: string | null;
  certainty: MemoryCertaintyValue;
  /** 1 (anecdotique) à 5 (essentiel). */
  importance: number;
  origin: "rules" | "llm" | "fallback";
};

/** Bilan d'une analyse, transmis à l'interface (événement « memory » du flux de chat). */
export type MemoryUpdate = {
  saved: string[];
  updated: string[];
  removed: number;
  /** Informations déjà connues, renforcées sans changement visible. */
  reinforced: number;
  rejected: string[];
  /** Analyse faite sans le modèle (indisponible après plusieurs tentatives) : seules les règles ont été appliquées. */
  degraded?: string;
};

export const emptyMemoryUpdate = (): MemoryUpdate => ({ saved: [], updated: [], removed: 0, reinforced: 0, rejected: [] });

export const hasVisibleChange = (u: MemoryUpdate) => u.saved.length > 0 || u.updated.length > 0 || u.removed > 0 || u.rejected.length > 0;

export const KIND_LABELS: Record<MemoryKindValue, string> = {
  PREFERENCE: "Préférence",
  FACT: "Information",
  PROJECT: "Projet",
  DECISION: "Décision",
  CONSTRAINT: "Contrainte",
  OBJECTIVE: "Objectif",
};

export const CERTAINTY_LABELS: Record<MemoryCertaintyValue, string> = {
  CONFIRMED: "Confirmé",
  STATED: "Exprimé",
  UNCERTAIN: "Hypothèse",
};
