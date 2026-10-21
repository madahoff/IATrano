import "server-only";
import type { ContextStreamEvent } from "@/lib/chat/protocol";
import type { LlmProvider } from "@/lib/llm/types";
import { autoUpdateMemories } from "@/lib/memory/auto";
import { compactConversation } from "./compact";
import { computeContextUsage } from "./service";

/**
 * Tâches lancées après une réponse terminée (le flux reste ouvert pour en informer l'interface) :
 * 1. mise à jour de la mémoire persistante si l'utilisateur a demandé de retenir ou d'oublier quelque chose ;
 * 2. compaction automatique si le prochain prompt dépasse le seuil configuré.
 * Aucune de ces étapes ne peut faire échouer la réponse déjà enregistrée.
 */
export async function afterResponse(opts: {
  userId: string;
  conversationId: string;
  modelId: string;
  userMessage: string;
  answer: string;
  provider: LlmProvider;
  think: boolean | undefined;
  signal: AbortSignal;
  emit: (event: ContextStreamEvent) => void;
}) {
  if (opts.signal.aborted) return;
  const memory = await autoUpdateMemories({
    userId: opts.userId,
    conversationId: opts.conversationId,
    userMessage: opts.userMessage,
    answer: opts.answer,
    provider: opts.provider,
    model: opts.modelId,
    think: opts.think,
  });
  if (memory) opts.emit({ type: "memory", ...memory });

  if (opts.signal.aborted) return;
  try {
    const usage = await computeContextUsage(opts.userId, opts.conversationId, opts.modelId);
    const threshold = usage.thresholds.autoCompact;
    if (threshold <= 0 || usage.percent < threshold || usage.compactable === 0) return;
    opts.emit({ type: "compaction", status: "running", message: `Contexte à ${Math.round(usage.percent)} % : compaction automatique des anciens échanges…` });
    const result = await compactConversation({ userId: opts.userId, conversationId: opts.conversationId, modelId: opts.modelId, trigger: "auto", signal: opts.signal });
    opts.emit({
      type: "compaction",
      status: "done",
      message: result.status === "compacted" ? `Contexte compacté : ≈ ${result.tokensBefore} → ${result.tokensAfter} tokens (estimation).` : result.reason,
    });
  } catch (err) {
    opts.emit({ type: "compaction", status: "failed", message: err instanceof Error ? err.message : "Compaction automatique impossible." });
  }
}
