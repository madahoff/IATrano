"use client";

import { useState } from "react";
import { Brain, ChevronDown, Loader2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

/**
 * Zone de raisonnement : affiche uniquement le flux « thinking » renvoyé par le fournisseur,
 * jamais mélangé à la réponse. Repliée par défaut (« Voir le raisonnement ») : l'utilisateur l'ouvre s'il le souhaite.
 */
export function ThinkingBlock({ thinking, active, answerStarted }: { thinking: string; active: boolean; answerStarted: boolean }) {
  const [open, setOpen] = useState(false);
  const words = thinking.trim().split(/\s+/).filter(Boolean).length;
  const thinkingNow = active && !answerStarted;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-3">
      <CollapsibleTrigger className="group inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        {thinkingNow ? <Loader2 className="size-3.5 animate-spin" /> : <Brain className="size-3.5" />}
        {thinkingNow ? "Qwen réfléchit…" : open ? "Masquer le raisonnement" : "Voir le raisonnement"}
        <span className="font-normal opacity-70">· {words} mot{words > 1 ? "s" : ""}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 max-h-[min(50vh,28rem)] overflow-y-auto rounded-2xl bg-muted px-4 py-3 text-muted-foreground">
          <Markdown content={thinking} className="text-[0.85rem] leading-6" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
