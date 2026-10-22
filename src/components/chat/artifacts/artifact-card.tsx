"use client";

import { AlertTriangle, ChevronRight, Loader2, Sparkles } from "lucide-react";
import type { ArtifactRef } from "@/lib/artifacts/types";
import { cn } from "@/lib/utils";

/** Carte cliquable dans le fil de conversation : rouvre la page interactive dans le panneau. */
export function ArtifactCard({ artifact, active, onOpen }: { artifact: ArtifactRef; active: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(artifact.id)}
      aria-pressed={active}
      className={cn(
        "mt-3 flex w-full max-w-md items-center gap-3 rounded-2xl border border-border bg-background px-4 py-3 text-left transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active && "bg-muted",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
        {artifact.valid ? <Sparkles className="size-4" /> : <AlertTriangle className="size-4 text-warning-foreground" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{artifact.title}</span>
        <span className="block text-xs text-muted-foreground">
          Page interactive · v{artifact.version}
          {!artifact.valid && " · à corriger"}
        </span>
      </span>
      <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
        {active ? "Ouverte" : "Ouvrir"}
        <ChevronRight className="size-4" />
      </span>
    </button>
  );
}

/** Indicateur pendant la génération du code de la page. */
export function ArtifactBuilding({ title, chars }: { title: string; chars: number }) {
  return (
    <div className="mt-3 flex w-full max-w-md items-center gap-3 rounded-2xl border border-dashed border-border px-4 py-3" role="status">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        <Loader2 className="size-4 animate-spin" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">Création de l&apos;interface…</span>
        <span className="block truncate text-xs text-muted-foreground">
          {title}
          {chars > 0 && ` · ${chars.toLocaleString("fr-FR")} caractères`}
        </span>
      </span>
    </div>
  );
}
