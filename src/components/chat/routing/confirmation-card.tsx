"use client";

import { useState } from "react";
import { Check, Signpost, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MODE_LABELS, ROUTING_MODES, type RoutingMode } from "@/lib/routing/config";
import { ModeIcon } from "./mode-icon";
import type { ConfirmationChoice, Outcomes } from "@/lib/routing/decide";

const pct = (p: number | null) => (p === null ? "" : ` (${Math.round(p * 100)} %)`);

/** Modes séparés par « · », chacun précédé de son icône. */
function ModeList({ modes, outcomes }: { modes: RoutingMode[]; outcomes: Outcomes }) {
  return modes.map((m, i) => (
    <span key={m} className="whitespace-nowrap">
      {i > 0 && " · "}
      <ModeIcon mode={m} className="mr-1 inline size-3.5 align-[-0.15em]" />
      {MODE_LABELS[m]}
      {pct(outcomes[m].p)}
    </span>
  ));
}

/**
 * Carte affichée AVANT l'appel à Qwen quand JEV propose des modes à confirmer :
 * « JEV propose : Réflexion approfondie (82 %) · Recherche web (71 %) », chaque mode précédé de son icône.
 */
export function RoutingConfirmationCard({
  outcomes,
  onConfirm,
  onCancel,
}: {
  outcomes: Outcomes;
  onConfirm: (choice: ConfirmationChoice, accepted: RoutingMode[]) => void;
  onCancel: () => void;
}) {
  const proposed = ROUTING_MODES.filter((m) => outcomes[m].state === "ask");
  const already = ROUTING_MODES.filter((m) => outcomes[m].state === "on");
  const [checked, setChecked] = useState<RoutingMode[]>(proposed);
  const toggle = (m: RoutingMode) => setChecked((c) => (c.includes(m) ? c.filter((x) => x !== m) : [...c, m]));

  return (
    <section aria-label="Modes proposés par JEV" className="rounded-3xl border border-border bg-background p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <Signpost className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="flex-1 text-sm font-medium">
          JEV propose : <ModeList modes={proposed} outcomes={outcomes} />
        </p>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1 text-muted-foreground" onClick={onCancel} aria-label="Annuler l'envoi et modifier le message">
          <X />
        </Button>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {proposed.map((m) => (
          <li key={m}>
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-muted px-3 py-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={checked.includes(m)} onChange={() => toggle(m)} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium">
                  <ModeIcon mode={m} className="size-3.5 shrink-0" />
                  {MODE_LABELS[m]}
                  {pct(outcomes[m].p)}
                </span>
                <span className="block text-xs text-muted-foreground">{outcomes[m].reason}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {already.length > 0 && (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          Déjà activé : <ModeList modes={already} outcomes={outcomes} />
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onConfirm("accept", checked)}>
          <Check /> Valider
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onConfirm("reject", [])}>
          Répondre sans ces modes
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onConfirm("always", checked)} disabled={checked.length === 0}>
          Toujours accepter pour cette conversation
        </Button>
      </div>
    </section>
  );
}
