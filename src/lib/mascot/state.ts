// État de la mascotte « Trano », dérivé uniquement des événements réels du chat (flux /api/chat et
// routage JEV). Aucune minuterie ne simule d'activité : si un événement manque, l'état reste générique.
// Module pur, partagé navigateur/tests — n'importe aucun module serveur ni three.js.
import type { MessageStatus } from "@/lib/chat/protocol";
import type { ResearchStatus, ResearchStep } from "@/lib/search/research-types";

export const MASCOT_STATES = ["idle", "listening", "thinking", "searching", "generating", "completed", "error", "asking"] as const;
export type MascotState = (typeof MASCOT_STATES)[number];

/** Sous-étape de la recherche Web, lue sur l'étape réellement « en cours » côté serveur. */
export type SearchPhase = "scan" | "read" | "analyze";

export type MascotSnapshot = {
  state: MascotState;
  /** Uniquement pour « searching ». */
  phase?: SearchPhase;
  /** Statut lisible (affiché et annoncé aux lecteurs d'écran) ; vide au repos. */
  label: string;
};

/** Ce que la mascotte lit du dernier message de l'assistant. */
export type AssistantSignal = {
  /** Identifiant temporaire tant que le serveur n'a pas confirmé le démarrage (« start »). */
  started: boolean;
  status: MessageStatus;
  hasText: boolean;
  hasThinking: boolean;
  thinkingEnabled: boolean;
  hasClarification: boolean;
  buildingArtifact: boolean;
  research: { status: ResearchStatus; steps: Pick<ResearchStep, "kind" | "status">[] } | null;
};

export type MascotInput = {
  /** Routage JEV en attente : analyse de la demande, ou confirmation demandée à l'utilisateur. */
  routing: "analyzing" | "confirm" | null;
  isStreaming: boolean;
  /** Dernier message de la conversation s'il vient de l'assistant. */
  assistant: AssistantSignal | null;
  /** Échec avant tout démarrage (requête refusée, réseau) : la conversation est restaurée telle quelle. */
  requestFailed: boolean;
  /** La dernière réponse vient de se terminer pendant cette session (geste de satisfaction). */
  justCompleted: boolean;
  /** Nom court du modèle pour les libellés (« Qwen »). */
  modelName: string;
};

export function searchPhase(steps: Pick<ResearchStep, "kind" | "status">[]): SearchPhase {
  const running = steps.findLast((s) => s.status === "running");
  switch (running?.kind) {
    case "fetch":
      return "read";
    case "select":
    case "context":
    case "generate":
      return "analyze";
    default:
      return "scan";
  }
}

const PHASE_LABELS: Record<SearchPhase, string> = {
  scan: "Recherche sur le Web…",
  read: "Lecture des pages trouvées…",
  analyze: "Analyse des sources…",
};

export function deriveMascotState(input: MascotInput): MascotSnapshot {
  const { assistant: a, modelName } = input;

  if (input.routing === "confirm") return { state: "asking", label: "Confirmez les modes proposés pour continuer" };
  if (input.routing === "analyzing") return { state: "listening", label: "JEV analyse votre demande…" };

  if (input.isStreaming && a?.status === "STREAMING") {
    // Requête envoyée, serveur pas encore démarré : la mascotte écoute encore.
    if (!a.started) return { state: "listening", label: "Envoi de votre demande…" };
    const researching = a.research && (a.research.status === "running" || a.research.steps.some((s) => s.status === "running"));
    // Tant que le texte n'a pas commencé, la recherche en cours prime ; ensuite la rédaction.
    if (researching && !a.hasText) {
      const phase = searchPhase(a.research!.steps);
      return { state: "searching", phase, label: PHASE_LABELS[phase] };
    }
    if (a.buildingArtifact) return { state: "generating", label: "Création de la page interactive…" };
    if (a.hasText) return { state: "generating", label: `${modelName} rédige la réponse…` };
    if (a.hasThinking || a.thinkingEnabled) return { state: "thinking", label: `${modelName} réfléchit…` };
    return { state: "thinking", label: `${modelName} prépare la réponse…` };
  }
  // Flux en cours sans message assistant identifiable : état générique de traitement.
  if (input.isStreaming) return { state: "thinking", label: `${modelName} travaille…` };

  if (input.requestFailed) return { state: "error", label: "La demande n'a pas pu être envoyée" };
  if (!a) return { state: "idle", label: "" };
  if (a.status === "ERROR") return { state: "error", label: "La génération a échoué" };
  if (a.status === "CANCELLED") return { state: "idle", label: "" };
  if (a.status === "COMPLETE" && a.hasClarification) return { state: "asking", label: `${modelName} attend votre précision` };
  if (a.status === "COMPLETE" && input.justCompleted) return { state: "completed", label: "Réponse terminée" };
  return { state: "idle", label: "" };
}

/** Nom court d'un identifiant de modèle : « qwen3:32b » → « Qwen ». */
export function shortModelName(model: string | null | undefined): string {
  const name = (model ?? "").split(":")[0].split("/").pop() ?? "";
  const base = name.match(/^[a-z]+/i)?.[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1).toLowerCase() : "L'IA";
}
