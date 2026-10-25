import { File, FileAudio, FileImage, FileJson, FileSpreadsheet, FileText, FileVideo, Presentation } from "lucide-react";
import type { FileKind } from "@/lib/files/types";
import { cn } from "@/lib/utils";

const ICONS: Record<FileKind, typeof File> = {
  PDF: FileText,
  DOCX: FileText,
  PPTX: Presentation,
  XLSX: FileSpreadsheet,
  CSV: FileSpreadsheet,
  TEXT: FileText,
  MARKDOWN: FileText,
  JSON: FileJson,
  HTML: File,
  IMAGE: FileImage,
  VIDEO: FileVideo,
  AUDIO: FileAudio,
};

// Teinte discrète par famille (couleurs du thème, lisibles en clair comme en sombre).
const TONES: Partial<Record<FileKind, string>> = {
  PDF: "text-destructive",
  DOCX: "text-primary",
  XLSX: "text-success",
  CSV: "text-success",
  PPTX: "text-warning-foreground",
};

export function FileIcon({ kind, className }: { kind: FileKind; className?: string }) {
  const Icon = ICONS[kind] ?? File;
  return <Icon className={cn("shrink-0", TONES[kind] ?? "text-muted-foreground", className)} aria-hidden />;
}
