// Quand la mascotte émet un son : décisions pures, dérivées des changements d'état réels.
import type { MascotState, SearchPhase } from "./state";

export type SoundCue = "wake" | "think" | "search" | "done" | "error" | "ask" | "stop" | null;

const ACTIVE: MascotState[] = ["listening", "thinking", "searching", "generating"];

/**
 * Son à jouer lors d'un changement d'état. Les changements de sous-étape de recherche
 * (lecture, analyse) restent silencieux : seul le démarrage d'une vraie recherche sonne.
 */
export function soundForTransition(prev: { state: MascotState; phase?: SearchPhase }, next: { state: MascotState; phase?: SearchPhase }): SoundCue {
  if (prev.state === next.state) return null;
  switch (next.state) {
    case "listening":
      return ACTIVE.includes(prev.state) ? null : "wake";
    case "thinking":
      // Réflexion qui suit directement l'écoute : petit « hmm » (ignoré s'il arrive trop vite).
      return prev.state === "listening" ? "think" : null;
    case "searching":
      return "search";
    case "completed":
      return "done";
    case "error":
      return "error";
    case "asking":
      return "ask";
    case "idle":
      // Retour au repos depuis une activité : annulation — on coupe le son en cours.
      return ACTIVE.includes(prev.state) ? "stop" : null;
    default:
      return null;
  }
}

/**
 * Intervalle (s) avant le prochain tapotement pendant la rédaction, selon le temps écoulé depuis
 * son début : réguliers au départ, de plus en plus espacés, puis plus aucun sur les longues réponses.
 */
export function tickInterval(elapsedS: number): [number, number] | null {
  if (elapsedS < 8) return [0.55, 1.0];
  if (elapsedS < 25) return [1.6, 3.0];
  return null;
}
