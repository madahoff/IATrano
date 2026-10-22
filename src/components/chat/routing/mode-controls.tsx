"use client";

import { useState } from "react";
import { Ban, Check, ChevronDown, CircleHelp, Signpost } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AUTH_MODE_HELP, AUTH_MODE_LABELS, AUTH_MODES, MODE_HELP, MODE_LABELS, MODE_SHORT, type AuthMode, type RoutingMode } from "@/lib/routing/config";
import type { Availability, Override, Overrides } from "@/lib/routing/decide";
import { cn } from "@/lib/utils";
import { ModeIcon } from "./mode-icon";

/** Sélecteur du mode d'autorisation (Automatique / Manuel / Hybride / Désactivé), toujours visible dans le chat. */
export function AuthModeSelector({ value, onChange, disabled }: { value: AuthMode; onChange: (m: AuthMode) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} className="h-9 gap-1.5 px-3 text-muted-foreground hover:bg-accent" aria-label={`Mode d'autorisation de JEV : ${AUTH_MODE_LABELS[value]}`}>
          <Signpost />
          <span className="hidden sm:inline">{AUTH_MODE_LABELS[value]}</span>
          <ChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[min(92vw,22rem)] p-1.5">
        <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">Comment JEV choisit les modes</p>
        <ul role="radiogroup" aria-label="Mode d'autorisation">
          {AUTH_MODES.map((m) => (
            <li key={m}>
              <button
                type="button"
                role="radio"
                aria-checked={m === value}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <Check className={cn("mt-0.5 size-4 shrink-0", m === value ? "opacity-100" : "opacity-0")} />
                <span>
                  <span className="block text-sm font-medium">{AUTH_MODE_LABELS[m]}</span>
                  <span className="block text-xs text-muted-foreground">{AUTH_MODE_HELP[m]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Bouton d'un mode : automatique (JEV décide) → forcé → désactivé ; en mode « Désactivé », simple interrupteur. */
function ModeButton({
  mode,
  value,
  manual,
  availability,
  forbidden,
  onChange,
}: {
  mode: RoutingMode;
  value: Override | undefined;
  manual: boolean;
  availability: { available: boolean; reason?: string };
  forbidden: boolean;
  onChange: (v: Override | undefined) => void;
}) {
  const disabled = !availability.available || forbidden;
  const state: "auto" | "on" | "off" = manual ? (value === "on" ? "on" : "off") : (value ?? "auto");
  const next = (): Override | undefined => (manual ? (state === "on" ? "off" : "on") : state === "auto" ? "on" : state === "on" ? "off" : undefined);
  const tip = forbidden
    ? `${MODE_LABELS[mode]} : interdit par l'administration.`
    : !availability.available
      ? (availability.reason ?? "Indisponible.")
      : manual
        ? state === "on"
          ? `${MODE_LABELS[mode]} activé pour le prochain message. Cliquez pour le désactiver.`
          : `Cliquez pour activer : ${MODE_LABELS[mode].toLowerCase()}.`
        : state === "auto"
          ? `Automatique : JEV décide. Cliquez pour forcer « ${MODE_LABELS[mode]} » sur le prochain message.`
          : state === "on"
            ? `Forcé pour le prochain message (votre choix prime sur JEV). Cliquez pour le désactiver.`
            : `Désactivé pour le prochain message. Cliquez pour revenir en automatique.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={disabled ? 0 : -1} className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-pressed={state === "on" ? true : state === "off" ? false : "mixed"}
            aria-label={`${MODE_LABELS[mode]} : ${state === "auto" ? "automatique" : state === "on" ? "activé" : "désactivé"}`}
            onClick={() => onChange(next())}
            className={cn(
              "h-9 gap-1.5 px-3 text-muted-foreground hover:bg-accent",
              state === "on" && "bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground",
              state === "off" && !manual && "text-muted-foreground/70 line-through decoration-1",
            )}
          >
            {state === "off" && !manual ? <Ban /> : <ModeIcon mode={mode} />}
            <span className="hidden sm:inline">{MODE_SHORT[mode]}</span>
            {state === "auto" && <span className="hidden rounded-full bg-background/70 px-1.5 text-[0.65rem] font-medium tracking-wide sm:inline">AUTO</span>}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function ModeButtons({
  authMode,
  overrides,
  availability,
  forbidden,
  visible,
  onChange,
}: {
  authMode: AuthMode;
  overrides: Overrides;
  availability: Availability;
  forbidden: Record<RoutingMode, boolean>;
  visible: RoutingMode[];
  onChange: (mode: RoutingMode, v: Override | undefined) => void;
}) {
  return (
    <>
      {visible.map((m) => (
        <ModeButton key={m} mode={m} value={overrides[m]} manual={authMode === "OFF"} availability={availability[m]} forbidden={forbidden[m]} onChange={(v) => onChange(m, v)} />
      ))}
    </>
  );
}

/** Aide intégrée : chaque mode et chaque mode d'autorisation en une ou deux phrases. */
export function RoutingHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Aide sur les modes">
          <CircleHelp />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[min(92vw,26rem)] gap-3 p-4 text-sm">
        <div>
          <p className="font-medium">Les modes</p>
          <ul className="mt-1.5 flex flex-col gap-1.5 text-muted-foreground">
            {(Object.keys(MODE_HELP) as RoutingMode[]).map((m) => (
              <li key={m}>
                <span className="inline-flex items-center gap-1.5 align-middle text-foreground">
                  <ModeIcon mode={m} className="size-3.5" />
                  {MODE_LABELS[m]}
                </span>{" "}
                — {MODE_HELP[m]}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">Qui décide ?</p>
          <p className="mt-1 text-muted-foreground">Avant chaque réponse, JEV lit votre demande et estime quels modes seraient utiles.</p>
          <ul className="mt-1.5 flex flex-col gap-1.5 text-muted-foreground">
            {AUTH_MODES.map((m) => (
              <li key={m}>
                <span className="text-foreground">{AUTH_MODE_LABELS[m]}</span> — {AUTH_MODE_HELP[m]}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-muted-foreground">Les boutons sous le champ de saisie forcent ou désactivent un mode pour le prochain message : votre choix prime toujours sur JEV.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
