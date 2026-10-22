import { MODE_LABELS, ROUTING_MODES, type AuthMode, type ModesConfig, type RoutingMode } from "./config";

// Décision de routage : fonctions pures, partagées par le serveur (application réelle) et le navigateur
// (zone de test de l'administration). Aucune entrée/sortie ici.

/** Choix de l'utilisateur pour un message : forcer (on) ou désactiver (off) un mode ; absent = laisser décider. */
export type Override = "on" | "off";
export type Overrides = Partial<Record<RoutingMode, Override>>;

export type Availability = Record<RoutingMode, { available: boolean; reason?: string }>;

/**
 * Origine de l'état d'un mode :
 *  - jev : seuil appliqué automatiquement ; user : bouton de l'utilisateur ; confirmed/refused : réponse à la carte ;
 *  - conversation : « Toujours accepter pour cette conversation » ; admin : règle d'administration ;
 *  - fallback : JEV injoignable ; unavailable : fonction indisponible (moteur non configuré, modèle incompatible…).
 */
export type OutcomeSource = "jev" | "user" | "confirmed" | "refused" | "conversation" | "admin" | "fallback" | "unavailable";

export type ModeOutcome = {
  mode: RoutingMode;
  /** P(oui) renvoyée par JEV (null si non consulté). */
  p: number | null;
  state: "on" | "off" | "ask";
  source: OutcomeSource;
  /** Explication courte en français. */
  reason: string;
};

export type Outcomes = Record<RoutingMode, ModeOutcome>;

export type DecideInput = {
  authMode: AuthMode;
  modes: ModesConfig;
  highThreshold: number;
  /** null : JEV non consulté (mode désactivé) ou injoignable (voir jevFailed). */
  probabilities: Record<RoutingMode, number> | null;
  jevFailed: boolean;
  fallbackModes: RoutingMode[];
  overrides: Overrides;
  autoAccept: RoutingMode[];
  availability: Availability;
};

const pct = (p: number) => `${Math.round(p * 100)} %`;

export function decideMode(mode: RoutingMode, input: DecideInput): ModeOutcome {
  const cfg = input.modes[mode];
  const p = input.probabilities?.[mode] ?? null;
  const out = (state: ModeOutcome["state"], source: OutcomeSource, reason: string): ModeOutcome => ({ mode, p, state, source, reason });
  const avail = input.availability[mode];

  if (!avail.available) return out("off", "unavailable", avail.reason ?? "Indisponible.");
  if (cfg.rule === "FORBIDDEN") return out("off", "admin", "Mode interdit par l'administration.");

  // Le choix explicite de l'utilisateur prime sur JEV (mais pas sur une interdiction de l'administration).
  const override = input.overrides[mode];
  if (override === "on") return out("on", "user", "Activé par vous.");
  if (override === "off") return out("off", "user", "Désactivé par vous.");

  if (input.authMode === "OFF") return out("off", "user", "Non activé (JEV désactivé).");
  if (input.jevFailed || p === null) {
    return input.fallbackModes.includes(mode)
      ? out("on", "fallback", "JEV indisponible : mode de repli.")
      : out("off", "fallback", "JEV indisponible : réponse simple.");
  }
  if (p < cfg.threshold) return out("off", "jev", `JEV ${pct(p)} < seuil ${pct(cfg.threshold)}.`);

  let state: ModeOutcome["state"] = input.authMode === "AUTO" ? "on" : input.authMode === "MANUAL" ? "ask" : p >= input.highThreshold ? "on" : "ask";
  let reason =
    state === "on"
      ? `Décidé par JEV (${pct(p)}).`
      : input.authMode === "HYBRID"
        ? `JEV hésite (${pct(p)}, entre ${pct(cfg.threshold)} et ${pct(input.highThreshold)}) : confirmation demandée.`
        : `Proposé par JEV (${pct(p)}).`;
  if (cfg.rule === "CONFIRM") {
    state = "ask";
    reason = `Proposé par JEV (${pct(p)}) ; l'administration exige une confirmation pour ce mode.`;
    return out(state, "jev", reason);
  }
  if (state === "ask" && input.autoAccept.includes(mode)) return out("on", "conversation", `Accepté d'office pour cette conversation (JEV ${pct(p)}).`);
  return out(state, "jev", reason);
}

export function decideRouting(input: DecideInput): { outcomes: Outcomes; needsConfirmation: boolean } {
  const outcomes = Object.fromEntries(ROUTING_MODES.map((m) => [m, decideMode(m, input)])) as Outcomes;
  return { outcomes, needsConfirmation: ROUTING_MODES.some((m) => outcomes[m].state === "ask") };
}

export type ConfirmationChoice = "accept" | "reject" | "always";

/**
 * Applique la réponse de l'utilisateur à la carte de confirmation.
 * accept/always : les modes cochés (parmi ceux proposés) sont activés, les autres refusés ; reject : tout est refusé.
 */
export function applyConfirmation(outcomes: Outcomes, choice: ConfirmationChoice, accepted: RoutingMode[]): Outcomes {
  const next = { ...outcomes };
  for (const m of ROUTING_MODES) {
    const o = outcomes[m];
    if (o.state !== "ask") continue;
    const yes = choice !== "reject" && accepted.includes(m);
    const p = o.p === null ? "" : ` (JEV ${pct(o.p)})`;
    next[m] = yes ? { ...o, state: "on", source: "confirmed", reason: `Confirmé par vous${p}.` } : { ...o, state: "off", source: "refused", reason: `Refusé par vous${p}.` };
  }
  return next;
}

/** Modes à ajouter à « Toujours accepter » après le choix « always ». */
export function autoAcceptAfter(outcomes: Outcomes, choice: ConfirmationChoice, accepted: RoutingMode[], current: RoutingMode[]): RoutingMode[] {
  if (choice !== "always") return current;
  const add = ROUTING_MODES.filter((m) => outcomes[m].state === "ask" && accepted.includes(m));
  return [...new Set([...current, ...add])];
}

export const finalModes = (outcomes: Outcomes): RoutingMode[] => ROUTING_MODES.filter((m) => outcomes[m].state === "on");

/** Qui a décidé, pour le journal : JEV, l'utilisateur, l'administration ou le repli. */
export function decidedBy(outcomes: Outcomes): "jev" | "user" | "admin" | "fallback" {
  const sources = ROUTING_MODES.map((m) => outcomes[m].source);
  if (sources.some((s) => s === "user" || s === "confirmed" || s === "refused" || s === "conversation")) return "user";
  if (sources.some((s) => s === "fallback")) return "fallback";
  if (sources.every((s) => s === "admin" || s === "unavailable")) return "admin";
  return "jev";
}

/** Libellé de proposition pour la carte : « 🧠 Réflexion approfondie (82 %) ». */
export function proposalLabel(o: ModeOutcome): string {
  return `${MODE_LABELS[o.mode]}${o.p === null ? "" : ` (${pct(o.p)})`}`;
}

/** Instantané enregistré avec chaque réponse (étiquettes « 🧠 Réflexion · 🔍 Recherche » au-dessus du message). */
export type RoutingSnapshot = {
  authMode: AuthMode;
  /** JEV consulté mais injoignable : mode de repli appliqué. */
  jevUnavailable: boolean;
  outcomes: ModeOutcome[];
};

export function snapshotOf(authMode: AuthMode, outcomes: Outcomes, jevUnavailable: boolean): RoutingSnapshot {
  return { authMode, jevUnavailable, outcomes: ROUTING_MODES.map((m) => outcomes[m]) };
}

export function parseSnapshot(raw: unknown): RoutingSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as RoutingSnapshot;
  return Array.isArray(s.outcomes) ? s : null;
}
