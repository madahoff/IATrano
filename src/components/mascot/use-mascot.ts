"use client";

import { useEffect, useState } from "react";
import { deriveMascotState, shortModelName, type MascotSnapshot } from "@/lib/mascot/state";
import type { UIMessage } from "@/components/chat/use-chat";

/** Durée du geste de satisfaction après une réponse complète, avant le retour au repos. */
const COMPLETED_MS = 2200;

export type MascotView = MascotSnapshot & { feed: number; nudge: number };

/** État de la mascotte pour la conversation affichée (voir deriveMascotState). */
export function useMascot(opts: {
  messages: UIMessage[];
  isStreaming: boolean;
  requestFailed: boolean;
  routing: "analyzing" | "confirm" | null;
  model: string | null;
}): MascotView {
  const last = opts.messages.at(-1);
  const assistant = last?.role === "ASSISTANT" ? last : null;

  // Fin de flux observée pendant cette session : geste de satisfaction (jamais au chargement d'une conversation).
  const [wasStreaming, setWasStreaming] = useState(opts.isStreaming);
  const [justCompleted, setJustCompleted] = useState(false);
  if (wasStreaming !== opts.isStreaming) {
    setWasStreaming(opts.isStreaming);
    setJustCompleted(!opts.isStreaming && assistant?.status === "COMPLETE");
  }
  useEffect(() => {
    if (!justCompleted) return;
    const id = setTimeout(() => setJustCompleted(false), COMPLETED_MS);
    return () => clearTimeout(id);
  }, [justCompleted]);

  const snapshot = deriveMascotState({
    routing: opts.routing,
    isStreaming: opts.isStreaming,
    requestFailed: opts.requestFailed,
    justCompleted,
    modelName: shortModelName(assistant?.model ?? opts.model),
    assistant: assistant && {
      started: !assistant.id.startsWith("temp-"),
      status: assistant.status,
      hasText: assistant.content.length > 0,
      hasThinking: Boolean(assistant.thinking),
      thinkingEnabled: assistant.thinkingEnabled,
      hasClarification: Boolean(assistant.clarification),
      buildingArtifact: Boolean(assistant.artifactBuilding),
      research: assistant.research && { status: assistant.research.status, steps: assistant.research.steps },
    },
  });

  const streaming = assistant?.status === "STREAMING";
  return {
    ...snapshot,
    feed: streaming ? assistant.content.length + (assistant.thinking?.length ?? 0) + (assistant.artifactBuilding?.chars ?? 0) : 0,
    nudge: assistant?.research?.steps.filter((s) => s.status === "done").length ?? 0,
  };
}
