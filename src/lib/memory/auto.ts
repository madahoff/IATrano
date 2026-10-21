import "server-only";
import { db } from "@/lib/db";
import { errorDetails, logEvent } from "@/lib/logger";
import type { LlmProvider } from "@/lib/llm/types";
import { buildMemoryExtractionPrompt, hasMemoryCue, MEMORY_ACTIONS_JSON_SCHEMA, parseMemoryActions } from "./extract";
import { findDuplicate } from "./select";
import { autoMemoryRejected, sensitiveReason } from "./sensitive";
import { createMemory, getMemorySettings } from "./service";

export type MemoryUpdate = { saved: string[]; updated: string[]; removed: number; rejected: string[] };

/**
 * Après une réponse : si l'utilisateur a exprimé quelque chose à retenir (ou à oublier), le modèle propose
 * des actions sur la mémoire, validées ici avant écriture. Ne fait rien si la mémoire est désactivée.
 */
export async function autoUpdateMemories(opts: {
  userId: string;
  conversationId: string;
  userMessage: string;
  answer: string;
  provider: LlmProvider;
  model: string;
  think: boolean | undefined;
}): Promise<MemoryUpdate | null> {
  if (!hasMemoryCue(opts.userMessage)) return null;
  const settings = await getMemorySettings(opts.userId);
  if (!settings.autoSave) return null;
  // Un message contenant un secret n'est jamais transmis à l'extraction.
  const secret = sensitiveReason(opts.userMessage);
  if (secret) return { saved: [], updated: [], removed: 0, rejected: [secret] };
  try {
    const existing = await db.memory.findMany({ where: { userId: opts.userId }, orderBy: { updatedAt: "desc" }, take: 40 });
    const refs = new Map(existing.map((m, i) => [`M${i + 1}`, m.id]));
    const raw = await opts.provider.completeJson(
      {
        model: opts.model,
        messages: buildMemoryExtractionPrompt(
          opts.userMessage,
          opts.answer,
          existing.map((m, i) => ({ ref: `M${i + 1}`, kind: m.kind, project: m.project, content: m.content })),
        ),
        think: opts.think,
        temperature: 0,
        signal: AbortSignal.timeout(45_000),
      },
      MEMORY_ACTIONS_JSON_SCHEMA as unknown as Record<string, unknown>,
    );
    const result: MemoryUpdate = { saved: [], updated: [], removed: 0, rejected: [] };
    for (const action of parseMemoryActions(raw, refs)) {
      if (action.action === "delete") {
        result.removed += (await db.memory.deleteMany({ where: { id: action.id, userId: opts.userId } })).count;
        continue;
      }
      const reason = autoMemoryRejected(action.content);
      if (reason) {
        result.rejected.push(reason);
        continue;
      }
      if (action.action === "update") {
        if (existing.some((m) => m.id === action.id && m.content === action.content)) continue;
        // Correction : la nouvelle formulation remplace l'ancienne (pas d'informations contradictoires).
        const res = await db.memory.updateMany({ where: { id: action.id, userId: opts.userId }, data: { content: action.content, source: "AUTO" } });
        if (res.count) result.updated.push(action.content);
        continue;
      }
      const dup = findDuplicate(action.content, existing);
      if (dup) {
        if (dup.content !== action.content) {
          await db.memory.updateMany({ where: { id: dup.id, userId: opts.userId }, data: { content: action.content } });
          result.updated.push(action.content);
        }
        continue;
      }
      const { memory } = await createMemory(opts.userId, { ...action, source: "AUTO", sourceConversationId: opts.conversationId });
      existing.push(memory);
      result.saved.push(memory.content);
    }
    return result.saved.length || result.updated.length || result.removed || result.rejected.length ? result : null;
  } catch (err) {
    await logEvent("INFO", "memory:auto", "Mise à jour automatique de la mémoire impossible", errorDetails(err), opts.userId);
    return null;
  }
}
