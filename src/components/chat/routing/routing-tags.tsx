"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MODE_EMOJI, MODE_SHORT } from "@/lib/routing/config";
import type { ModeOutcome, RoutingSnapshot } from "@/lib/routing/decide";

const pct = (p: number) => `${Math.round(p * 100)} %`;

/** Phrase courte et sans jargon : « Décidé par JEV (82 %) », « Choisi par vous »… */
export function originLabel(o: ModeOutcome): string {
  switch (o.source) {
    case "jev":
      return o.p === null ? "Décidé par JEV" : `Décidé par JEV (${pct(o.p)})`;
    case "user":
      return "Choisi par vous";
    case "confirmed":
      return o.p === null ? "Confirmé par vous" : `Proposé par JEV (${pct(o.p)}), confirmé par vous`;
    case "conversation":
      return o.p === null ? "Accepté d'office pour cette conversation" : `Accepté d'office pour cette conversation (JEV ${pct(o.p)})`;
    case "fallback":
      return "Appliqué d'office : JEV était indisponible";
    default:
      return o.reason;
  }
}

function Tag({ outcome }: { outcome: ModeOutcome }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span aria-hidden>{MODE_EMOJI[outcome.mode]}</span>
          {MODE_SHORT[outcome.mode]}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-auto max-w-72 px-3 py-2 text-xs" onOpenAutoFocus={(e) => e.preventDefault()}>
        {originLabel(outcome)}
      </PopoverContent>
    </Popover>
  );
}

/** Étiquettes des modes utilisés, au-dessus de la réponse. */
export function RoutingTags({ routing }: { routing: RoutingSnapshot }) {
  const on = routing.outcomes.filter((o) => o.state === "on");
  if (!on.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Modes utilisés pour cette réponse">
      {on.map((o) => (
        <Tag key={o.mode} outcome={o} />
      ))}
    </div>
  );
}
