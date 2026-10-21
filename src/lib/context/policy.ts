import { countTextTokens, MESSAGE_OVERHEAD_TOKENS } from "@/lib/llm/tokens";

// Choix des messages à compacter : on garde toujours intacts les derniers échanges (continuité naturelle),
// dans la limite de 35 % de la capacité, et on résume ce qui précède. Fonction pure.

export const KEEP_MIN_MESSAGES = 2;
export const KEEP_MAX_MESSAGES = 6;
export const KEEP_MAX_SHARE = 0.35;
/** En dessous, un résumé structuré ne serait pas plus court que les échanges eux-mêmes. */
export const MIN_COMPACT_TOKENS = 300;

export function splitForCompaction<T extends { role: "USER" | "ASSISTANT"; content: string }>(messages: T[], capacity: number) {
  const visible = messages.filter((m) => m.content.trim());
  let keepFrom = visible.length;
  let kept = 0;
  while (keepFrom > 0) {
    const next = visible[keepFrom - 1];
    const cost = countTextTokens(next.content) + MESSAGE_OVERHEAD_TOKENS;
    const count = visible.length - keepFrom;
    if (count >= KEEP_MIN_MESSAGES && (count >= KEEP_MAX_MESSAGES || kept + cost > capacity * KEEP_MAX_SHARE)) break;
    keepFrom--;
    kept += cost;
  }
  // La partie résumée se termine sur une réponse de l'assistant (échange complet).
  while (keepFrom > 0 && visible[keepFrom - 1].role === "USER") keepFrom--;
  const head = visible.slice(0, keepFrom);
  const headTokens = head.reduce((n, m) => n + countTextTokens(m.content) + MESSAGE_OVERHEAD_TOKENS, 0);
  if (headTokens < MIN_COMPACT_TOKENS) return { toSummarize: [] as T[], keep: visible, keptTokens: kept + headTokens };
  return { toSummarize: head, keep: visible.slice(keepFrom), keptTokens: kept };
}
