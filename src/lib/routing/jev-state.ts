import type { Message } from "@prisma/client";
import { countTextTokens } from "@/lib/llm/tokens";

// Texte envoyé à JEV pour le routage (fonctions pures).

/** Contexte maximal de JEV : 8 192 tokens. On garde une large marge pour les questions et le gabarit. */
export const JEV_STATE_TOKEN_BUDGET = 6000;
const CONTEXT_CHARS = 400;

export function clip(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Tronque un texte (en tokens estimés) en conservant le début et la fin, où se trouvent souvent la consigne et la question. */
function fitTokens(text: string, budget: number): string {
  if (countTextTokens(text) <= budget) return text;
  let chars = Math.floor(budget * 3);
  let out = text;
  while (chars > 200) {
    const half = Math.floor(chars / 2);
    out = `${text.slice(0, half)}\n[…]\n${text.slice(-half)}`;
    if (countTextTokens(out) <= budget) return out;
    chars = Math.floor(chars * 0.8);
  }
  return text.slice(0, 600);
}

/** Message à analyser, précédé si utile d'un court rappel de l'échange précédent (suivi : « et en 2025 ? »). */
export function buildJevState(content: string, previous: Array<Pick<Message, "role" | "content">>, includeContext: boolean): string {
  const lastUser = includeContext ? previous.filter((m) => m.role === "USER").at(-1) : undefined;
  const lastAssistant = includeContext ? previous.filter((m) => m.role === "ASSISTANT").at(-1) : undefined;
  const context = [lastUser && `User: ${clip(lastUser.content, CONTEXT_CHARS)}`, lastAssistant && `Assistant: ${clip(lastAssistant.content, CONTEXT_CHARS)}`].filter(Boolean).join("\n");
  const header = context ? `Previous exchange (context only):\n${context}\n\nCurrent user request:\n` : "";
  return header + fitTokens(content.trim(), JEV_STATE_TOKEN_BUDGET - countTextTokens(header));
}
