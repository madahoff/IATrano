"use client";

import type { MascotState } from "@/lib/mascot/state";
import { cn } from "@/lib/utils";
import { Mascot } from "./mascot";
import type { MascotView } from "./use-mascot";

/** États dont le libellé reste visible ; les autres ne sont annoncés qu'aux lecteurs d'écran. */
const SHOWN: MascotState[] = ["listening", "thinking", "searching", "generating", "asking", "error"];

/**
 * Présence de l'assistant sous le dernier échange : mascotte compacte et statut textuel.
 * Toujours au même endroit de l'arbre React pour que l'animation reste continue d'un état à l'autre.
 */
export function AssistantPresence({ mascot }: { mascot: MascotView }) {
  const shown = SHOWN.includes(mascot.state) && mascot.label;
  return (
    <div className="-mt-2 flex items-center gap-2">
      <Mascot variant="compact" state={mascot.state} phase={mascot.phase} feed={mascot.feed} nudge={mascot.nudge} className="-ml-2 size-14" />
      <p role="status" aria-live="polite" className={cn("min-w-0 truncate text-sm", mascot.state === "error" ? "text-destructive" : "text-muted-foreground", !shown && "sr-only")}>
        {mascot.label}
      </p>
    </div>
  );
}
