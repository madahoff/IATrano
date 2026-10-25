"use client";

import { useState } from "react";
import { Scan, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { contentUrl, ErrorNotice, ReadOnlyNote, ViewerToolbar, type ViewerProps } from "./common";

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Image en haute résolution : ajustée à l'espace disponible, ou zoomée (taille réelle × facteur) avec défilement. */
export function ImageViewer({ file }: ViewerProps) {
  const [zoom, setZoom] = useState<number | null>(null); // null : ajuster au panneau
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState(false);
  const step = (dir: 1 | -1) => {
    const current = zoom ?? 1;
    const next = dir > 0 ? ZOOMS.find((z) => z > current + 0.001) : [...ZOOMS].reverse().find((z) => z < current - 0.001);
    if (next) setZoom(next);
  };
  if (error) return <ErrorNotice message="Cette image ne peut pas être affichée par le navigateur (format non pris en charge ou fichier corrompu). Téléchargez-la pour l’ouvrir." />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(-1)} aria-label="Zoom arrière">
          <ZoomOut />
        </Button>
        <span className="w-14 text-center text-xs tabular-nums">{zoom === null ? "Ajusté" : `${Math.round(zoom * 100)} %`}</span>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(1)} aria-label="Zoom avant">
          <ZoomIn />
        </Button>
        <Button type="button" variant={zoom === null ? "secondary" : "ghost"} size="sm" onClick={() => setZoom(null)}>
          <Scan /> Ajuster
        </Button>
        <Button type="button" variant={zoom === 1 ? "secondary" : "ghost"} size="sm" onClick={() => setZoom(1)}>
          100 %
        </Button>
        <div className="flex-1" />
        {natural && <span className="text-xs text-muted-foreground tabular-nums">{natural.w} × {natural.h} px</span>}
        <ReadOnlyNote>Lecture seule</ReadOnlyNote>
      </ViewerToolbar>
      <div className={cn("min-h-0 flex-1 overflow-auto bg-muted/50", zoom === null && "flex items-center justify-center p-4")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- fichier privé servi par l'API */}
        <img
          src={contentUrl(file)}
          alt={file.name}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setError(true)}
          style={zoom !== null && natural ? { width: natural.w * zoom, maxWidth: "none" } : undefined}
          className={cn(zoom === null ? "max-h-full max-w-full object-contain" : "m-4 block", "rounded-sm shadow-sm [image-rendering:auto]")}
        />
      </div>
    </div>
  );
}
