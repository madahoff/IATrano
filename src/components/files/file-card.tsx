"use client";

import { AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fileBadge, type FileKind } from "@/lib/files/types";
import { cn } from "@/lib/utils";
import { FileThumb } from "./file-thumb";

const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

export function formatFileSize(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${nf.format(n / 1024)} Ko`;
  return `${nf.format(n / 1024 / 1024)} Mo`;
}

/**
 * Carte compacte d'un fichier joint (zone de saisie, messages) : miniature, nom, type. Un clic l'ouvre dans le
 * panneau d'aperçu ; sans `onOpen` (fichier non conservé), la carte est purement informative.
 */
export function FileCard({
  id,
  name,
  kind,
  version,
  sizeBytes,
  localUrl,
  serverThumbnail,
  warning,
  onOpen,
  onRemove,
  unavailableReason,
  className,
}: {
  id?: string | null;
  name: string;
  kind: FileKind;
  version?: number;
  sizeBytes?: number;
  localUrl?: string | null;
  serverThumbnail?: boolean;
  warning?: string | null;
  onOpen?: () => void;
  onRemove?: () => void;
  unavailableReason?: string;
  className?: string;
}) {
  const meta = [fileBadge(name, kind), sizeBytes !== undefined ? formatFileSize(sizeBytes) : null].filter(Boolean).join(" · ");
  const body = (
    <>
      <FileThumb id={id} kind={kind} version={version} localUrl={localUrl} serverThumbnail={serverThumbnail} className="size-10" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-xs font-medium" title={name}>
          {name}
        </span>
        <span className="flex items-center gap-1 truncate text-[0.7rem] text-muted-foreground tabular-nums">
          {warning && <AlertCircle className="size-3 shrink-0 text-warning-foreground" aria-label={warning} />}
          {meta}
        </span>
      </span>
    </>
  );
  return (
    <div className={cn("group/file relative flex w-56 max-w-full shrink-0 items-center rounded-xl bg-background ring-1 ring-border/60 transition-colors", onOpen && "hover:bg-accent/60", className)} title={unavailableReason ?? warning ?? undefined}>
      {onOpen ? (
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-1.5 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ouvrir l’aperçu de ${name}`}>
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2.5 p-1.5 pr-2 opacity-80">{body}</span>
      )}
      {onRemove && (
        <Button type="button" variant="ghost" size="icon-xs" className="mr-1 size-7 shrink-0 sm:size-6" onClick={onRemove} aria-label={`Retirer ${name}`} title="Retirer">
          <X />
        </Button>
      )}
    </div>
  );
}
