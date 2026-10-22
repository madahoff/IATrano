// Types partagés du pipeline documentaire (aucun import serveur : utilisables par les tests et l'interface).

export type DocumentKindName = "PDF" | "DOCX" | "PPTX" | "XLSX" | "CSV" | "TEXT" | "MARKDOWN" | "JSON" | "HTML" | "IMAGE" | "VIDEO" | "AUDIO";

export type UnitMethod = "TEXT" | "OCR" | "TRANSCRIPT" | "KEYFRAME" | "NONE";
export type UnitStatus = "OK" | "EMPTY" | "PARTIAL" | "FAILED" | "SKIPPED";
export type SegmentKind = "TEXT" | "TABLE" | "CAPTION" | "OCR" | "TRANSCRIPT" | "VISUAL" | "NOTE";

/**
 * Unité d'origine extraite (page, diapositive, feuille, image, tranche de vidéo).
 * `text` est le texte canonique, en Markdown léger : « # Titre » pour les titres détectés,
 * tableaux Markdown (| a | b |), « > Légende : … » pour les légendes. C'est ce texte qui est conservé
 * (consultation du passage original) et découpé en segments.
 */
export type ExtractedUnit = {
  number: number;
  label?: string | null;
  method: UnitMethod;
  status: UnitStatus;
  text: string;
  confidence?: number | null;
  error?: string | null;
  imagePath?: string | null;
  visual?: VisualAnalysis | null;
  startMs?: number | null;
  endMs?: number | null;
  /** Page à passer à l'OCR (PDF sans texte exploitable) */
  needsOcr?: boolean;
};

export type VisualAnalysis = {
  model: string;
  description: string;
  elements: string[];
  /** Texte lu par le modèle (complète l'OCR) */
  text?: string;
  kind?: string;
};

export type Block =
  | { type: "heading"; level: number; text: string; unit: number; startMs?: number | null; endMs?: number | null }
  | { type: "paragraph" | "caption" | "note"; text: string; unit: number; source: SegmentKind; startMs?: number | null; endMs?: number | null }
  | { type: "table"; header: string | null; rows: string[]; caption?: string | null; unit: number; source: SegmentKind };

export type SectionDraft = {
  ordinal: number;
  level: number;
  title: string;
  path: string[];
  pageStart: number | null;
  pageEnd: number | null;
  startMs: number | null;
  endMs: number | null;
  tokenCount: number;
  contentHash: string;
  /** Texte complet de la section (analyse progressive) — non persisté */
  text: string;
};

export type SegmentDraft = {
  ordinal: number;
  content: string;
  tokenCount: number;
  page: number | null;
  pageEnd: number | null;
  sectionOrdinal: number | null;
  sectionPath: string[];
  type: SegmentKind;
  startMs: number | null;
  endMs: number | null;
  contentHash: string;
};

export type StageProgress = { done: number; total: number; failed?: number; skipped?: number; note?: string };
export type DocumentProgress = Partial<Record<"extract" | "ocr" | "segment" | "embed" | "analyze" | "synthesize", StageProgress>>;

/** Passage documentaire numéroté transmis au modèle et affiché comme source. */
export type DocSourceDTO = {
  n: number;
  documentId: string;
  projectId: string;
  name: string;
  kind: DocumentKindName;
  page: number | null;
  pageEnd: number | null;
  section: string | null;
  startMs: number | null;
  endMs: number | null;
  type: SegmentKind | "INSIGHT";
  /** Synthèse produite par l'IA (pas un passage original) */
  derived: boolean;
  excerpt: string;
};

export type CitationCheckDTO = { n: number; supported: boolean; score: number };

export type DocumentRetrievalDTO = {
  intent: string;
  queries: string[];
  sources: DocSourceDTO[];
  cited: number[] | null;
  checks: CitationCheckDTO[];
  limitations: string[];
};

export type MethodContent = {
  name: string;
  objective: string;
  context: string;
  prerequisites: string[];
  steps: string[];
  tools: string[];
  decisionRules: string[];
  inputs: string[];
  outputs: string[];
  pitfalls: string[];
  limits: string[];
  examples: string[];
};

export type InsightSource = { page: number | null; pageEnd?: number | null; section: string | null; startMs?: number | null };
