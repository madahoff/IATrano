// Types du contexte partagés entre le serveur et le navigateur — ne doit importer aucun module serveur.

export type ContextState = "normal" | "warn" | "high" | "critical";

/** Origine de la fenêtre de contexte retenue pour le modèle. */
export type WindowSource =
  // Réglage manuel de l'administration pour ce modèle
  | "manual"
  // Fenêtre par défaut de l'application, envoyée explicitement au moteur (num_ctx d'Ollama)
  | "app-default"
  // Valeur annoncée par le serveur (fenêtre chargée)
  | "provider"
  // Aucune information : valeur par défaut supposée, à configurer
  | "assumed";

export type ContextParts = {
  system: number;
  memory: number;
  summary: number;
  user: number;
  assistant: number;
  rag: number;
  tools: number;
};

export type ContextThresholds = { warn: number; high: number; autoCompact: number };

/** Ce qui est stocké sur chaque réponse (Message.contextUsage) : le prompt réellement envoyé. */
export type StoredRequestUsage = {
  /** Estimation des tokens du prompt envoyé (avant recalibrage). */
  estimated: number;
  window: number;
  reserve: number;
  parts: ContextParts;
  sentMessages: number;
  droppedMessages: number;
  summaryVersion: number | null;
  memoryIds: string[];
};

export type SummarySections = {
  objective: string;
  /** Demandes de l'utilisateur, citées (condensées) telles qu'écrites : jamais reformulées par le modèle. */
  requests?: string[];
  constraints: string[];
  decisions: string[];
  facts: string[];
  state: string[];
  nextSteps: string[];
  references: SummaryReference[];
};

export type SummaryReference =
  | { type: "source"; label: string; url: string }
  | { type: "url"; label: string; url: string }
  | { type: "file"; label: string }
  | { type: "code"; label: string; lang: string | null; code: string | null; messageId: string };

export type SummaryDTO = {
  version: number;
  createdAt: string;
  model: string;
  trigger: "manual" | "auto";
  coveredCount: number;
  coveredUntil: string;
  sections: SummarySections;
  tokens: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  versions: number;
};

export type ContextUsageDTO = {
  model: string;
  window: number;
  reserve: number;
  /** Capacité effective du prompt : fenêtre − réserve de réponse. */
  capacity: number;
  windowSource: WindowSource;
  providerMax: number | null;
  /** Tokens que le prochain prompt occupera (estimation, recalibrée si une mesure existe). */
  used: number;
  usedRaw: number;
  remaining: number;
  percent: number;
  state: ContextState;
  thresholds: ContextThresholds;
  /** Toujours true : aucun moteur ne permet de compter un prompt avant de l'envoyer. */
  estimated: true;
  estimator: string;
  calibration: { factor: number; measured: number; estimated: number; at: string } | null;
  parts: ContextParts;
  messages: { total: number; sent: number; summarized: number; dropped: number };
  lastRequest: {
    at: string;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    estimated: number;
    window: number;
    rag: number;
    dropped: number;
  } | null;
  summary: SummaryDTO | null;
  compaction: { status: "RUNNING" | "SUCCEEDED" | "FAILED" | null; at: string | null; error: string | null };
  /** Ce qui peut encore être compacté (messages anciens hors des derniers échanges conservés). */
  compactable: number;
  memory: { enabled: boolean; injected: Array<{ id: string; kind: string; content: string; scope: "personal" | "project" }> };
};

export function contextState(percent: number, t: ContextThresholds): ContextState {
  if (percent >= 100) return "critical";
  if (percent >= t.high) return "high";
  if (percent >= t.warn) return "warn";
  return "normal";
}

export const PART_LABELS: Record<keyof ContextParts, string> = {
  system: "Instructions système",
  memory: "Mémoire persistante",
  summary: "Résumé compacté",
  user: "Messages de l'utilisateur",
  assistant: "Réponses de l'assistant",
  rag: "Documents Web (RAG)",
  tools: "Résultats d'outils",
};
