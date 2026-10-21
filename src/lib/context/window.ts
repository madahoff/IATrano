import type { ProviderKind } from "@/lib/llm/types";
import type { WindowSource } from "./types";

// Fenêtre de contexte effective d'un modèle. Fonctions pures (testées dans tests/unit/context.test.ts).
//
// Ollama charge chaque modèle avec num_ctx = 4096 par défaut, quelle que soit la longueur maximale annoncée
// par /api/show (32 768 pour qwen2.5:3b) : au-delà, il tronque silencieusement le DÉBUT du prompt.
// L'application envoie donc toujours num_ctx explicitement, ce qui rend la fenêtre connue et réelle.
// Les serveurs compatibles OpenAI fixent la fenêtre au chargement du modèle : on ne peut que la lire
// (quand ils l'exposent) ou la faire renseigner par l'administration.

export const MIN_WINDOW = 1024;
export const MAX_WINDOW = 1_048_576;

export type WindowOverride = { contextWindow: number; responseReserve: number | null } | null;

export type ResolvedWindow = {
  window: number;
  reserve: number;
  capacity: number;
  source: WindowSource;
  providerMax: number | null;
  /** Valeur à transmettre au moteur (num_ctx) ; undefined si le moteur ne permet pas de la choisir. */
  numCtx: number | undefined;
};

export function resolveWindow(opts: {
  providerKind: ProviderKind;
  providerMax: number | null | undefined;
  override: WindowOverride;
  appDefaultWindow: number;
  appReserve: number;
}): ResolvedWindow {
  const providerMax = opts.providerMax && opts.providerMax > 0 ? opts.providerMax : null;
  let window: number;
  let source: WindowSource;
  if (opts.override) {
    window = opts.override.contextWindow;
    source = "manual";
  } else if (opts.providerKind === "OLLAMA") {
    window = Math.min(opts.appDefaultWindow, providerMax ?? Infinity);
    source = "app-default";
  } else if (providerMax) {
    window = providerMax;
    source = "provider";
  } else {
    window = opts.appDefaultWindow;
    source = "assumed";
  }
  window = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round(window)));
  // La réserve ne peut pas dévorer plus de la moitié de la fenêtre.
  const wanted = opts.override?.responseReserve ?? opts.appReserve;
  const reserve = Math.max(128, Math.min(Math.floor(window / 2), Math.round(wanted)));
  return {
    window,
    reserve,
    capacity: window - reserve,
    source,
    providerMax,
    numCtx: opts.providerKind === "OLLAMA" ? window : undefined,
  };
}

export const WINDOW_SOURCE_LABELS: Record<WindowSource, string> = {
  manual: "Réglage manuel de l'administration",
  "app-default": "Fenêtre par défaut de l'application, imposée au moteur",
  provider: "Annoncée par le serveur IA",
  assumed: "Valeur supposée : le serveur n'indique pas sa fenêtre",
};
