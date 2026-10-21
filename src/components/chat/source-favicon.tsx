"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Icône du site : uniquement l'icône déclarée par la page elle-même (même domaine) ou /favicon.ico du domaine.
 * En cas d'échec de chargement, pastille avec l'initiale du domaine — jamais le logo d'un autre site.
 */
export function SourceFavicon({ src, host, className }: { src: string | null; host: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const letter = (host.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  if (!src || failed) {
    return (
      <span aria-hidden className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-[0.6rem] font-semibold text-muted-foreground", className)}>
        {letter}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- icône externe minuscule, pas d'optimisation Next utile
    <img
      src={src}
      alt=""
      aria-hidden
      width={16}
      height={16}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("size-4 shrink-0 rounded-full bg-background object-contain", className)}
    />
  );
}
