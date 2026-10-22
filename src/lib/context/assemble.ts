import { buildSystemPrompt, toChatTurns, type HistoryMessage } from "@/lib/llm/prompt";
import { countMessagesTokens, countTextTokens, MESSAGE_OVERHEAD_TOKENS, REPLY_PRIMER_TOKENS } from "@/lib/llm/tokens";
import type { ChatMessage } from "@/lib/llm/types";
import type { ContextParts } from "./types";

// Construction du contexte ACTIF, c'est-à-dire exactement ce qui est envoyé au modèle :
//   system = consignes de l'application + mémoire persistante sélectionnée + résumé de compaction
//   puis les messages postérieurs au résumé, les plus anciens étant écartés s'ils ne tiennent pas.
// L'historique enregistré n'est jamais modifié ici.

export type AssembledContext = {
  messages: ChatMessage[];
  parts: ContextParts;
  /** Tokens estimés du prompt (somme des parties). */
  total: number;
  sentMessages: number;
  droppedMessages: number;
};

export const SUMMARY_HEADER =
  "RÉSUMÉ DES ÉCHANGES PRÉCÉDENTS — les messages plus anciens de cette conversation ont été compactés dans ce résumé (l'utilisateur conserve l'historique complet). Appuie-toi dessus pour assurer la continuité :";

export const MEMORY_HEADER =
  "MÉMOIRE DE L'UTILISATEUR — informations retenues lors de conversations précédentes (l'utilisateur peut les consulter et les supprimer). Ce ne sont PAS des messages de la conversation actuelle. Applique les préférences ; utilise le reste seulement si c'est utile à la demande, sans le réciter. Une mention « non confirmé » signale une hypothèse à ne pas présenter comme un fait :";

export const PROJECT_MEMORY_HEADER = (name: string | null) =>
  `MÉMOIRE DU PROJET${name ? ` « ${name} »` : ""} — décisions, contraintes et contexte partagés par les conversations de ce projet (valables uniquement dans ce projet) :`;

/** Rappel au modèle : la mémorisation est assurée par l'application après sa réponse. */
export const MEMORY_CAPABILITY_NOTE =
  "Une mémoire persistante est gérée par l'application : quand l'utilisateur demande de retenir ou d'oublier quelque chose, c'est pris en compte automatiquement après ta réponse. Ne prétends pas en être incapable et n'invente pas de souvenirs absents de la mémoire ci-dessous.";

export function assembleContext(opts: {
  systemPrompt?: string | null;
  clarifications: boolean;
  now?: Date;
  memoryLines?: string[];
  /** Souvenirs propres au projet de la conversation (section distincte). */
  projectMemoryLines?: string[];
  projectName?: string | null;
  /** La mémoire persistante est active pour cet utilisateur (ajoute MEMORY_CAPABILITY_NOTE). */
  memoryActive?: boolean;
  summaryText?: string | null;
  /** Messages postérieurs au résumé actif (ou tout l'historique s'il n'y en a pas). */
  history: HistoryMessage[];
  /** Budget de tokens du prompt (capacité effective). */
  capacity: number;
}): AssembledContext {
  const base = buildSystemPrompt(opts);
  const memoryBlock = [
    opts.memoryActive ? MEMORY_CAPABILITY_NOTE : "",
    opts.memoryLines?.length ? `${MEMORY_HEADER}\n${opts.memoryLines.map((l) => `- ${l}`).join("\n")}` : "",
    opts.projectMemoryLines?.length ? `${PROJECT_MEMORY_HEADER(opts.projectName ?? null)}\n${opts.projectMemoryLines.map((l) => `- ${l}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const summaryBlock = opts.summaryText?.trim() ? `${SUMMARY_HEADER}\n${opts.summaryText.trim()}` : "";
  const system = [base, memoryBlock, summaryBlock].filter(Boolean).join("\n\n");

  const parts: ContextParts = {
    system: countTextTokens(base) + MESSAGE_OVERHEAD_TOKENS + REPLY_PRIMER_TOKENS,
    memory: memoryBlock ? countTextTokens(memoryBlock) + 1 : 0,
    summary: summaryBlock ? countTextTokens(summaryBlock) + 1 : 0,
    user: 0,
    assistant: 0,
    rag: 0,
    tools: 0,
  };

  const turns = toChatTurns(opts.history);
  const cost = turns.map((t) => countTextTokens(t.content) + MESSAGE_OVERHEAD_TOKENS);
  const fixed = parts.system + parts.memory + parts.summary;
  let start = 0;
  let total = fixed + cost.reduce((a, b) => a + b, 0);
  // Écarte les tours les plus anciens tant que le prompt dépasse la capacité (le dernier est toujours gardé).
  while (turns.length - start > 1 && total > opts.capacity) total -= cost[start++];
  // Une conversation envoyée au modèle commence par un message de l'utilisateur.
  while (turns.length - start > 1 && turns[start].role === "assistant") total -= cost[start++];

  const kept = turns.slice(start);
  kept.forEach((t, i) => {
    parts[t.role === "user" ? "user" : "assistant"] += cost[start + i];
  });
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...kept];
  // Le total fait foi : l'écart d'arrondi entre parties (jonctions de texte) est imputé au system.
  const exact = countMessagesTokens(messages);
  parts.system += exact - total;
  return { messages, parts, total: exact, sentMessages: kept.length, droppedMessages: start };
}

/**
 * Ajustement final, APRÈS les ajouts du backend au prompt (documents Web dans le dernier message,
 * consignes RAG dans le system) : recompte le prompt réel, attribue l'écart aux documents récupérés
 * et écarte si besoin d'autres tours anciens. Le system et le dernier message ne sont jamais retirés.
 */
export function finalizeContext(messages: ChatMessage[], assembled: AssembledContext, capacity: number) {
  const out = [...messages];
  let total = countMessagesTokens(out);
  const parts = { ...assembled.parts, rag: assembled.parts.rag + Math.max(0, total - assembled.total) };
  let dropped = assembled.droppedMessages;
  while (total > capacity && out.length > 2) {
    const removed = out.splice(1, 1)[0];
    const cost = countTextTokens(removed.content) + MESSAGE_OVERHEAD_TOKENS;
    total -= cost;
    parts[removed.role === "assistant" ? "assistant" : "user"] -= cost;
    dropped++;
    while (out.length > 2 && out[1].role === "assistant") {
      const extra = out.splice(1, 1)[0];
      const c = countTextTokens(extra.content) + MESSAGE_OVERHEAD_TOKENS;
      total -= c;
      parts.assistant -= c;
      dropped++;
    }
  }
  return { messages: out, total, parts, droppedMessages: dropped, sentMessages: out.length - 1 };
}
