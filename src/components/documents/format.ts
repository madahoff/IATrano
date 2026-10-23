// Libellés et formats partagés par les vues documentaires (client).
import { ACCEPTED_EXTENSIONS, KIND_LABELS, UNIT_LABELS } from "@/lib/documents/formats";
import type { DocumentKindName, DocumentProgress } from "@/lib/documents/types";

export { KIND_LABELS, UNIT_LABELS };
export const ACCEPT = ACCEPTED_EXTENSIONS.join(",");

export const STAGE_LABELS: Record<string, string> = {
  QUEUED: "En file d'attente",
  EXTRACT: "Extraction du contenu",
  OCR: "Lecture des images et de l'audio",
  SEGMENT: "Découpage et indexation",
  INDEX: "Indexation",
  EMBED: "Index sémantique",
  ANALYZE: "Analyse des sections",
  SYNTHESIZE: "Synthèse et méthodes",
  DONE: "Terminé",
};

export const STAGE_ORDER = ["EXTRACT", "OCR", "SEGMENT", "EMBED", "ANALYZE", "SYNTHESIZE"] as const;
export const PROGRESS_KEY: Record<(typeof STAGE_ORDER)[number], keyof DocumentProgress> = { EXTRACT: "extract", OCR: "ocr", SEGMENT: "segment", EMBED: "embed", ANALYZE: "analyze", SYNTHESIZE: "synthesize" };

export function formatBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
  return `${(n / 1024 ** 3).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Go`;
}

export function formatMs(ms: number | null | undefined) {
  if (ms == null) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Localisation lisible : « p. 12–13 », « diapo 4 », « 3:05 ». */
export function locationLabel(kind: DocumentKindName, p: { page: number | null; pageEnd?: number | null; startMs?: number | null; endMs?: number | null }) {
  if (p.startMs != null) return p.endMs != null && p.endMs - p.startMs >= 1000 ? `${formatMs(p.startMs)} – ${formatMs(p.endMs)}` : formatMs(p.startMs);
  if (p.page == null) return null;
  const unit = kind === "PDF" ? "p." : kind === "PPTX" ? "diapo" : kind === "XLSX" ? "feuille" : kind === "IMAGE" ? "image" : "partie";
  return p.pageEnd && p.pageEnd !== p.page ? `${unit} ${p.page}–${p.pageEnd}` : `${unit} ${p.page}`;
}

/** Lien vers le fichier original positionné sur la page (PDF) ou l'horodatage (vidéo, audio). */
export function originalHref(projectId: string, documentId: string, kind: DocumentKindName, p: { page?: number | null; startMs?: number | null }) {
  const base = `/api/projects/${projectId}/documents/${documentId}/file`;
  if ((kind === "VIDEO" || kind === "AUDIO") && p.startMs != null) return `${base}#t=${Math.floor(p.startMs / 1000)}`;
  if (kind === "PDF" && p.page) return `${base}#page=${p.page}`;
  return base;
}

/** Avancement global estimé (0–1) à partir des étapes déclarées par le serveur. */
export function overallProgress(stage: string, progress: DocumentProgress): number {
  if (stage === "DONE") return 1;
  const i = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  if (i < 0) return 0;
  const p = progress[PROGRESS_KEY[STAGE_ORDER[i]]];
  const within = p && p.total ? Math.min(1, p.done / p.total) : 0;
  const weights = [0.15, 0.15, 0.1, 0.1, 0.4, 0.1];
  return weights.slice(0, i).reduce((a, b) => a + b, 0) + weights[i] * within;
}
