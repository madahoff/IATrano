import type { DocumentKindName } from "./types";

// Détection du format : extension ET signature binaire (« magic bytes ») doivent concorder.
// Un fichier renommé (exécutable en .pdf, archive en .docx…) est refusé avant tout traitement.

type FormatDef = { kind: DocumentKindName; mime: string; magic?: (head: Buffer) => boolean };

const startsWith = (head: Buffer, bytes: number[], at = 0) => bytes.every((b, i) => head[at + i] === b);
const isZip = (h: Buffer) => startsWith(h, [0x50, 0x4b, 0x03, 0x04]);
const isPdf = (h: Buffer) => h.subarray(0, 1024).includes(Buffer.from("%PDF-"));
/** Texte : pas d'octet nul dans les premiers Ko (UTF-8 / UTF-16 avec BOM acceptés). */
const isText = (h: Buffer) => {
  if (startsWith(h, [0xff, 0xfe]) || startsWith(h, [0xfe, 0xff])) return true;
  return !h.subarray(0, 8192).includes(0);
};
const isIsoMedia = (h: Buffer) => h.subarray(4, 8).toString("latin1") === "ftyp";

const FORMATS: Record<string, FormatDef> = {
  ".pdf": { kind: "PDF", mime: "application/pdf", magic: isPdf },
  ".docx": { kind: "DOCX", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: isZip },
  ".pptx": { kind: "PPTX", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", magic: isZip },
  ".xlsx": { kind: "XLSX", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: isZip },
  ".csv": { kind: "CSV", mime: "text/csv", magic: isText },
  ".tsv": { kind: "CSV", mime: "text/tab-separated-values", magic: isText },
  ".txt": { kind: "TEXT", mime: "text/plain", magic: isText },
  ".log": { kind: "TEXT", mime: "text/plain", magic: isText },
  ".md": { kind: "MARKDOWN", mime: "text/markdown", magic: isText },
  ".markdown": { kind: "MARKDOWN", mime: "text/markdown", magic: isText },
  ".json": { kind: "JSON", mime: "application/json", magic: isText },
  ".html": { kind: "HTML", mime: "text/html", magic: isText },
  ".htm": { kind: "HTML", mime: "text/html", magic: isText },
  ".png": { kind: "IMAGE", mime: "image/png", magic: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47]) },
  ".jpg": { kind: "IMAGE", mime: "image/jpeg", magic: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  ".jpeg": { kind: "IMAGE", mime: "image/jpeg", magic: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  ".webp": { kind: "IMAGE", mime: "image/webp", magic: (h) => h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP" },
  ".gif": { kind: "IMAGE", mime: "image/gif", magic: (h) => h.subarray(0, 4).toString("latin1") === "GIF8" },
  ".bmp": { kind: "IMAGE", mime: "image/bmp", magic: (h) => startsWith(h, [0x42, 0x4d]) },
  ".tif": { kind: "IMAGE", mime: "image/tiff", magic: (h) => startsWith(h, [0x49, 0x49, 0x2a, 0x00]) || startsWith(h, [0x4d, 0x4d, 0x00, 0x2a]) },
  ".tiff": { kind: "IMAGE", mime: "image/tiff", magic: (h) => startsWith(h, [0x49, 0x49, 0x2a, 0x00]) || startsWith(h, [0x4d, 0x4d, 0x00, 0x2a]) },
  ".mp4": { kind: "VIDEO", mime: "video/mp4", magic: isIsoMedia },
  ".m4v": { kind: "VIDEO", mime: "video/mp4", magic: isIsoMedia },
  ".mov": { kind: "VIDEO", mime: "video/quicktime", magic: isIsoMedia },
  ".webm": { kind: "VIDEO", mime: "video/webm", magic: (h) => startsWith(h, [0x1a, 0x45, 0xdf, 0xa3]) },
  ".mkv": { kind: "VIDEO", mime: "video/x-matroska", magic: (h) => startsWith(h, [0x1a, 0x45, 0xdf, 0xa3]) },
  ".mp3": { kind: "AUDIO", mime: "audio/mpeg", magic: (h) => h.subarray(0, 3).toString("latin1") === "ID3" || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) },
  ".wav": { kind: "AUDIO", mime: "audio/wav", magic: (h) => h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WAVE" },
  ".m4a": { kind: "AUDIO", mime: "audio/mp4", magic: isIsoMedia },
  ".ogg": { kind: "AUDIO", mime: "audio/ogg", magic: (h) => h.subarray(0, 4).toString("latin1") === "OggS" },
};

export const ACCEPTED_EXTENSIONS = Object.keys(FORMATS);

export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export type DetectedFormat = { kind: DocumentKindName; mime: string; ext: string };

/** Renvoie le format reconnu, ou une raison de refus lisible. */
export function detectFormat(name: string, head: Buffer): DetectedFormat | { error: string } {
  const ext = extensionOf(name);
  const def = FORMATS[ext];
  if (!def) return { error: `Format non pris en charge (${ext || "sans extension"}). Formats acceptés : PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, JSON, HTML, images, vidéos et audio.` };
  if (head.length === 0) return { error: "Le fichier est vide." };
  if (def.magic && !def.magic(head)) return { error: `Le contenu du fichier ne correspond pas à son extension ${ext}.` };
  return { kind: def.kind, mime: def.mime, ext };
}

/** Nom affichable et sûr (aucun séparateur de chemin ni caractère de contrôle). */
export function safeDisplayName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "document";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "document";
}

export const KIND_LABELS: Record<DocumentKindName, string> = {
  PDF: "PDF",
  DOCX: "Word",
  PPTX: "Présentation",
  XLSX: "Classeur",
  CSV: "CSV",
  TEXT: "Texte",
  MARKDOWN: "Markdown",
  JSON: "JSON",
  HTML: "HTML",
  IMAGE: "Image",
  VIDEO: "Vidéo",
  AUDIO: "Audio",
};

export const UNIT_LABELS: Record<DocumentKindName, { one: string; many: string }> = {
  PDF: { one: "page", many: "pages" },
  DOCX: { one: "page", many: "pages" },
  PPTX: { one: "diapositive", many: "diapositives" },
  XLSX: { one: "feuille", many: "feuilles" },
  CSV: { one: "bloc", many: "blocs" },
  TEXT: { one: "partie", many: "parties" },
  MARKDOWN: { one: "partie", many: "parties" },
  JSON: { one: "partie", many: "parties" },
  HTML: { one: "partie", many: "parties" },
  IMAGE: { one: "image", many: "images" },
  VIDEO: { one: "tranche", many: "tranches" },
  AUDIO: { one: "tranche", many: "tranches" },
};
