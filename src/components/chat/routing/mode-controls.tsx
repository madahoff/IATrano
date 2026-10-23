"use client";

import { useState } from "react";
import { Ban, Check, ChevronDown, CircleHelp, Signpost } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AUTH_MODE_HELP, AUTH_MODE_LABELS, AUTH_MODES, MODE_HELP, MODE_LABELS, MODE_SHORT, type AuthMode, type RoutingMode } from "@/lib/routing/config";
import type { Availability, Override, Overrides } from "@/lib/routing/decide";
import { cn } from "@/lib/utils";
import { ModeIcon } from "./mode-icon";

/** Sélecteur du mode d'autorisation (Automatique / Manuel / Hybride / Désactivé), dans le panneau d'options du chat. */
export function AuthModeSelector({ value, onChange, disabled, showLabel }: { value: AuthMode; onChange: (m: AuthMode) => void; disabled?: boolean; showLabel?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} className="h-9 gap-1.5 px-3 text-muted-foreground hover:bg-accent" aria-label={`Mode d'autorisation de JEV : ${AUTH_MODE_LABELS[value]}`}>
          <Signpost />
          <span className={showLabel ? undefined : "hidden sm:inline"}>{AUTH_MODE_LABELS[value]}</span>
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

type ModeState = "auto" | "on" | "off";

const STATE_LABELS: Record<ModeState, string> = { auto: "Auto", on: "Oui", off: "Non" };

/** État affiché d'un mode : en mode « Désactivé » (manuel), simple marche / arrêt. */
export function modeState(value: Override | undefined, manual: boolean): ModeState {
  return manual ? (value === "on" ? "on" : "off") : (value ?? "auto");
}

/** Choix segmenté accessible (radiogroup, flèches pour changer d'option). */
function Segmented({ label, options, value, disabled, onChange }: { label: string; options: ModeState[]; value: ModeState; disabled: boolean; onChange: (v: ModeState) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className="inline-flex shrink-0 rounded-full bg-muted p-0.5"
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step || disabled) return;
        e.preventDefault();
        const next = options[(options.indexOf(value) + step + options.length) % options.length];
        onChange(next);
        (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          data-value={o}
          aria-checked={o === value}
          tabIndex={o === value ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(o)}
          className={cn(
            "h-8 min-w-11 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:h-7",
            o === value && (o === "on" ? "bg-primary text-primary-foreground hover:text-primary-foreground" : "bg-background text-foreground shadow-xs"),
          )}
        >
          {STATE_LABELS[o]}
        </button>
      ))}
    </div>
  );
}

/** Une ligne du panneau d'options : icône, libellé, état expliqué, choix Auto / Oui / Non. */
function ModeRow({
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
  const state = modeState(value, manual);
  const hint = forbidden
    ? "Interdit par l'administration."
    : !availability.available
      ? (availability.reason ?? "Indisponible.")
      : manual
        ? state === "on"
          ? "Activé pour vos messages."
          : "Désactivé."
        : state === "auto"
          ? "JEV décide."
          : state === "on"
            ? "Forcé pour le prochain message."
            : "Désactivé pour le prochain message.";
  return (
    <div className="flex min-h-11 items-center gap-2.5">
      <ModeIcon mode={mode} className={cn("size-4 shrink-0", state === "on" && !disabled ? "text-primary" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-5">{MODE_LABELS[mode]}</p>
        <p className="truncate text-xs leading-4 text-muted-foreground" title={hint}>
          {hint}
        </p>
      </div>
      <Segmented
        label={MODE_LABELS[mode]}
        options={manual ? ["off", "on"] : ["auto", "on", "off"]}
        value={state}
        disabled={disabled}
        onChange={(v) => onChange(v === "auto" ? undefined : v)}
      />
    </div>
  );
}

const GROUPS: Array<{ title: string; modes: RoutingMode[] }> = [
  { title: "Recherche et navigation", modes: ["research"] },
  { title: "Réflexion et génération", modes: ["thinking"] },
  { title: "Interaction et outils", modes: ["interactive"] },
];

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col">
      <h3 className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** Contenu du panneau d'options du chat : modes regroupés, pilotage par JEV, outils additionnels. */
export function ChatOptions({
  authMode,
  overrides,
  availability,
  forbidden,
  visible,
  onChange,
  onAuthModeChange,
  authDisabled,
  tools,
}: {
  authMode: AuthMode;
  overrides: Overrides;
  availability: Availability;
  forbidden: Record<RoutingMode, boolean>;
  visible: RoutingMode[];
  onChange: (mode: RoutingMode, v: Override | undefined) => void;
  onAuthModeChange: (m: AuthMode) => void;
  authDisabled?: boolean;
  /** Outils supplémentaires placés dans le groupe « Interaction et outils ». */
  tools?: React.ReactNode;
}) {
  const manual = authMode === "OFF";
  return (
    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {GROUPS.map((g) => {
        const modes = g.modes.filter((m) => visible.includes(m));
        if (!modes.length && !(tools && g.title === "Interaction et outils")) return null;
        return (
          <Group key={g.title} title={g.title}>
            {modes.map((m) => (
              <ModeRow key={m} mode={m} value={overrides[m]} manual={manual} availability={availability[m]} forbidden={forbidden[m]} onChange={(v) => onChange(m, v)} />
            ))}
            {g.title === "Interaction et outils" && tools && <div className="flex min-h-11 items-center empty:hidden">{tools}</div>}
          </Group>
        );
      })}
      <Group title="Pilotage par JEV">
        <div className="flex min-h-11 items-center gap-1">
          <AuthModeSelector value={authMode} onChange={onAuthModeChange} disabled={authDisabled} showLabel />
          <RoutingHelp />
        </div>
      </Group>
    </div>
  );
}

/** Rappel discret des options actives, affiché sur le bouton « Options » quand le panneau est fermé. */
export function activeOptions(overrides: Overrides, manual: boolean, visible: RoutingMode[]) {
  const on = visible.filter((m) => overrides[m] === "on");
  const off = manual ? [] : visible.filter((m) => overrides[m] === "off");
  const parts = [...on.map((m) => `${MODE_SHORT[m]} activé`), ...off.map((m) => `${MODE_SHORT[m]} désactivé`)];
  return {
    count: on.length + off.length,
    description: parts.join(", "),
    indicator: on.length + off.length ? (
      <span className="inline-flex items-center gap-0.5" aria-hidden>
        {on.map((m) => (
          <ModeIcon key={m} mode={m} className="size-3.5 text-primary" />
        ))}
        {off.length > 0 && <Ban className="size-3.5 text-muted-foreground" />}
      </span>
    ) : null,
  };
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
          <p className="mt-1.5 text-muted-foreground">Le panneau « Options » sous le champ de saisie force ou désactive un mode pour le prochain message : votre choix prime toujours sur JEV.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
