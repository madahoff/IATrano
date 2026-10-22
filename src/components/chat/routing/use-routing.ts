"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/client/api";
import type { ChatRequestBody } from "@/lib/chat/protocol";
import type { AuthMode, RoutingMode } from "@/lib/routing/config";
import { applyConfirmation, type ConfirmationChoice, type Outcomes, type Overrides } from "@/lib/routing/decide";

// Déroulé d'un envoi avec routage JEV :
//   1. /api/chat/routing : JEV analyse la demande (« JEV analyse votre demande… ») ;
//   2. si une confirmation est nécessaire, carte de confirmation AVANT d'appeler Qwen ;
//   3. /api/chat avec l'identifiant de la décision (et le choix de l'utilisateur).
// Si l'analyse échoue côté IATrano, l'envoi continue sans routage (jamais de blocage).

export type RoutedAction =
  /** artifactKey : demande de modification de la page interactive ouverte. */
  | { kind: "send"; content: string; artifactKey?: string }
  | { kind: "edit"; messageId: string; content: string; artifactKey?: string }
  | { kind: "regenerate"; assistantMessageId: string; userMessageId: string | null; content: string };

export type Proposal = {
  decisionId: string;
  authMode: AuthMode;
  outcomes: Outcomes;
  needsConfirmation: boolean;
  jev: { consulted: boolean; ok: boolean; error?: string };
};

export type PendingRouting = { action: RoutedAction; phase: "analyzing" } | { action: RoutedAction; phase: "confirm"; proposal: Proposal };

/** Appelé quand les modes sont fixés : routing null = envoi sans routage (repli si l'analyse a échoué). */
export type Dispatch = (action: RoutedAction, routing: ChatRequestBody["routing"] | null, outcomes: Outcomes | null) => void;

export function useRouting(opts: {
  getConversationId: () => string | null;
  model: string | null;
  authMode: AuthMode;
  overrides: Overrides;
  dispatch: Dispatch;
  onCancel: (action: RoutedAction) => void;
}) {
  const [pending, setPending] = useState<PendingRouting | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const start = useCallback(async (action: RoutedAction) => {
    const o = optsRef.current;
    if (!o.model) return;
    setPending({ action, phase: "analyzing" });
    try {
      const proposal = await api<Proposal>("/api/chat/routing", {
        method: "POST",
        json: {
          conversationId: o.getConversationId(),
          content: action.content,
          anchorMessageId: action.kind === "edit" ? action.messageId : action.kind === "regenerate" ? action.userMessageId : null,
          model: o.model,
          authMode: o.authMode,
          overrides: o.overrides,
        },
      });
      if (proposal.needsConfirmation) {
        setPending({ action, phase: "confirm", proposal });
        return;
      }
      setPending(null);
      o.dispatch(action, { decisionId: proposal.decisionId }, proposal.outcomes);
    } catch (err) {
      setPending(null);
      // Erreur de saisie ou d'accès : l'utilisateur doit corriger. Toute autre panne : envoi sans routage.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        toast.error(err.message);
        o.onCancel(action);
        return;
      }
      toast.warning("Analyse des modes indisponible : réponse envoyée avec vos réglages manuels.");
      o.dispatch(action, null, null);
    }
  }, []);

  const confirm = useCallback(
    (choice: ConfirmationChoice, accepted: RoutingMode[]) => {
      if (pending?.phase !== "confirm") return;
      setPending(null);
      const outcomes = applyConfirmation(pending.proposal.outcomes, choice, accepted);
      optsRef.current.dispatch(pending.action, { decisionId: pending.proposal.decisionId, choice, accepted }, outcomes);
    },
    [pending],
  );

  const cancel = useCallback(() => {
    if (!pending) return;
    setPending(null);
    optsRef.current.onCancel(pending.action);
  }, [pending]);

  return { pending, start, confirm, cancel };
}
