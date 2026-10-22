import "server-only";
import type { ContextStreamEvent } from "@/lib/chat/protocol";
import type { LlmProvider } from "@/lib/llm/types";
import { enqueueMemoryJob, processMemoryJob } from "@/lib/memory/jobs";
import { hasVisibleChange } from "@/lib/memory/types";
import { errorDetails, logEvent } from "@/lib/logger";
import { compactConversation } from "./compact";
import { computeContextUsage } from "./service";

/**
 * Tâches lancées après une réponse terminée (le flux reste ouvert pour en informer l'interface) :
 * 1. analyse du message pour la mémoire persistante : enregistrée en file d'attente (reprise après panne ou
 *    redémarrage), puis exécutée immédiatement ; l'interface n'est avertie que d'un changement réel ;
 * 2. compaction automatique si le prochain prompt dépasse le seuil configuré.
 * Aucune de ces étapes ne peut faire échouer la réponse déjà enregistrée.
 */
export async function afterResponse(opts: {
  userId: string;
  conversationId: string;
  projectId: string | null;
  modelId: string;
  userMessageId: string | null;
  userMessage: string;
  answer: string;
  provider: LlmProvider;
  think: boolean | undefined;
  signal: AbortSignal;
  emit: (event: ContextStreamEvent) => void;
}) {
  // La fermeture de l'onglet n'annule pas l'analyse : la tâche est persistée et dispose de son propre délai.
  try {
    const job = opts.userMessageId
      ? await enqueueMemoryJob({ userId: opts.userId, conversationId: opts.conversationId, messageId: opts.userMessageId, projectId: opts.projectId, model: opts.modelId, text: opts.userMessage })
      : null;
    if (job) {
      const outcome = await processMemoryJob(job.id, { provider: opts.provider, think: opts.think });
      if (outcome?.update && hasVisibleChange(outcome.update)) opts.emit({ type: "memory", ...outcome.update });
    }
  } catch (err) {
    await logEvent("WARN", "memory:after", "Analyse de la mémoire non planifiée", errorDetails(err), opts.userId);
  }

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
