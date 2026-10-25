// Types et règles des fichiers joints du chat, partagés entre le serveur et l'interface.

export type FileKind = "PDF" | "DOCX" | "PPTX" | "XLSX" | "CSV" | "TEXT" | "MARKDOWN" | "JSON" | "HTML" | "IMAGE" | "VIDEO" | "AUDIO";

/**
 * Mode d'édition proposé dans le panneau : texte brut, Markdown, JSON (validé), tableau CSV, ou texte des paragraphes
 * d'un document Word (mise en page conservée). null : lecture seule.
 */
export type FileEditMode = "text" | "markdown" | "json" | "csv" | "docx" | null;

export type ChatFileDTO = {
  id: string;
  name: string;
  kind: FileKind;
  mimeType: string;
  sizeBytes: number;
  version: number;
  pageCount: number | null;
  warning: string | null;
  editMode: FileEditMode;
  /** Le serveur sait produire une miniature (première page d'un PDF, image, image d'une vidéo). */
  hasThumbnail: boolean;
  /** Déjà envoyé dans un message : le texte transmis au modèle dans ce message reste celui d'origine. */
  sent: boolean;
  updatedAt: string;
};

/** Réponse de l'envoi d'un fichier : métadonnées + texte extrait transmis au modèle. */
export type ChatFileUpload = ChatFileDTO & { text: string };

export const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Formats acceptés dans le chat (HTML exclu : il ne serait jamais servi tel quel par l'application). */
export const CHAT_FILE_KINDS: FileKind[] = ["PDF", "DOCX", "PPTX", "XLSX", "CSV", "TEXT", "MARKDOWN", "JSON", "IMAGE", "VIDEO", "AUDIO"];

export const CHAT_FILE_ACCEPT = [
  ".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".tsv", ".txt", ".log", ".md", ".markdown", ".json",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".mp3", ".wav", ".m4a", ".ogg",
].join(",");

export function editModeOf(kind: FileKind): FileEditMode {
  switch (kind) {
    case "TEXT":
      return "text";
    case "MARKDOWN":
      return "markdown";
    case "JSON":
      return "json";
    case "CSV":
      return "csv";
    case "DOCX":
      return "docx";
    default:
      return null;
  }
}

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  PDF: "PDF",
  DOCX: "Document Word",
  PPTX: "Présentation",
  XLSX: "Classeur Excel",
  CSV: "Tableau CSV",
  TEXT: "Texte",
  MARKDOWN: "Markdown",
  JSON: "JSON",
  HTML: "HTML",
  IMAGE: "Image",
  VIDEO: "Vidéo",
  AUDIO: "Audio",
};

/** Extension affichée sur les cartes (« PDF », « DOCX »…), à défaut le type. */
export function fileBadge(name: string, kind: FileKind) {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  return (ext ?? kind).toUpperCase();
}
