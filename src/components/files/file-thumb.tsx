"use client";

import { useState } from "react";
import type { FileKind } from "@/lib/files/types";
import { cn } from "@/lib/utils";
import { FileIcon } from "./file-icon";

/**
 * Miniature d'un fichier : image locale (aperçu immédiat, avant même la réponse du serveur), sinon miniature
 * produite par le serveur (première page d'un PDF, image réduite, image d'une vidéo), sinon icône du type.
 */
export function FileThumb({
  id,
  kind,
  version,
  localUrl,
  serverThumbnail = true,
  className,
}: {
  id?: string | null;
  kind: FileKind;
  /** Version connue : l'URL devient cachable (la miniature d'une version ne change jamais). */
  version?: number;
  localUrl?: string | null;
  /** false : le serveur a indiqué qu'aucune miniature n'est possible (inutile de la demander). */
  serverThumbnail?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const canAsk = Boolean(id) && serverThumbnail && (kind === "PDF" || kind === "IMAGE" || kind === "VIDEO");
  const src = localUrl ?? (canAsk ? `/api/chat/files/${id}/thumbnail${version ? `?v=${version}` : ""}` : null);
  return (
    <span className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted", className)}>
      {src && failed !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- fichier privé servi par l'API (session), sans optimisation d'image
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} className={cn("size-full", kind === "PDF" ? "bg-white object-cover object-top" : "object-cover")} />
      ) : (
        <FileIcon kind={kind} className="size-5" />
      )}
    </span>
  );
}
