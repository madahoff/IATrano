import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import type { ChatMessage } from "./types";

// Estimation du nombre de tokens d'un prompt.
//
// Aucun moteur local courant n'expose de tokenizer public (Ollama n'a pas d'endpoint /api/tokenize) :
// on utilise donc le BPE cl100k, très proche de celui des familles Qwen 2/2.5/3 et Llama 3 pour le texte
// latin et le code, avec deux corrections mesurées contre Ollama (qwen2.5:3b) :
//  - les nombres sont découpés chiffre par chiffre (cl100k groupe par 3) ;
//  - chaque message ajoute ses marqueurs de gabarit (<|im_start|>rôle\n … <|im_end|>\n ≈ 5 tokens),
//    et la génération ouvre un tour assistant (≈ 3 tokens).
// Le résultat reste une ESTIMATION : il est ensuite recalibré par la mesure réelle (prompt_eval_count)
// renvoyée par le fournisseur après chaque réponse (voir src/lib/context/usage.ts).

export const MESSAGE_OVERHEAD_TOKENS = 5;
export const REPLY_PRIMER_TOKENS = 3;
export const ESTIMATOR_LABEL = "BPE cl100k + gabarit de conversation";

let encoder: Tiktoken | null = null;
function enc() {
  encoder ??= new Tiktoken(cl100k);
  return encoder;
}

const cache = new Map<string, number>();
const CACHE_MAX = 2000;

export function countTextTokens(text: string): number {
  if (!text) return 0;
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let n: number;
  try {
    n = enc().encode(text, [], []).length;
  } catch {
    // Texte pathologique : repli prudent sur ~3 caractères par token.
    n = Math.ceil(text.length / 3);
  }
  for (const run of text.match(/\d{2,}/g) ?? []) n += run.length - Math.ceil(run.length / 3);
  if (text.length > 64) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(text, n);
  }
  return n;
}

export function countMessageTokens(message: Pick<ChatMessage, "content">): number {
  return countTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** Tokens d'une liste de messages telle qu'envoyée au modèle (amorce de la réponse comprise). */
export function countMessagesTokens(messages: Array<Pick<ChatMessage, "content">>): number {
  return messages.reduce((n, m) => n + countMessageTokens(m), REPLY_PRIMER_TOKENS);
}
