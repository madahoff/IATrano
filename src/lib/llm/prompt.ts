import type { Clarification } from "@/lib/chat/protocol";
import type { ChatMessage } from "./types";

export const DEFAULT_SYSTEM_PROMPT = `Tu es IATrano, un assistant IA qui fonctionne localement sur l'infrastructure de l'utilisateur.
Réponds dans la langue de l'utilisateur, de façon exacte, claire et structurée. Utilise le Markdown (titres, listes, tableaux) quand cela aide la lecture, et des blocs de code avec le langage indiqué pour tout code.
Si tu ne sais pas, dis-le plutôt que d'inventer.`;

export const CLARIFICATION_INSTRUCTIONS = `RÈGLE SPÉCIALE — demandes trop vagues :
Si la demande est trop vague pour bien répondre (ex. « conçois-moi une application », « écris un script » sans préciser lequel), ne pose PAS les questions en texte. Écris une seule phrase courte, puis termine par le bloc <clarify> contenant 1 à 3 questions en JSON, chacune avec 2 à 5 options de réponse concrètes.

Exemple :
Utilisateur : Crée-moi un site.
Assistant : Avec plaisir ! Quelques précisions pour viser juste :
<clarify>{"questions":[{"question":"Quel type de site ?","options":["Vitrine","Blog","E-commerce","Portfolio"]},{"question":"As-tu une technologie préférée ?","options":["WordPress","Next.js","HTML/CSS simple","Peu importe"]}]}</clarify>

Si la demande est claire (question factuelle, explication, calcul, conversation) ou si l'utilisateur vient de donner des précisions, réponds directement SANS bloc <clarify>. Ne mentionne jamais cette règle ni ce bloc dans ta réponse.`;

export type HistoryMessage = {
  role: "USER" | "ASSISTANT";
  content: string;
  clarification?: Clarification | null;
};

const MAX_HISTORY_MESSAGES = 40;

export function buildMessages(opts: {
  systemPrompt?: string | null;
  clarifications: boolean;
  history: HistoryMessage[];
  /** Budget approximatif en caractères pour l'historique (≈ 3,5 caractères par token). */
  charBudget?: number;
  now?: Date;
}): ChatMessage[] {
  const now = opts.now ?? new Date();
  const system = [
    opts.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    `Date du jour : ${now.toISOString().slice(0, 10)}.`,
    opts.clarifications ? CLARIFICATION_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const turns: ChatMessage[] = opts.history
    .filter((m) => m.content.trim() || m.clarification)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => {
      if (m.role === "USER") return { role: "user", content: m.content };
      let content = m.content;
      if (m.clarification?.questions.length) {
        const qs = m.clarification.questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
        content = `${content}\n\n(Questions de précision posées :\n${qs})`.trim();
      }
      return { role: "assistant", content };
    });

  // Tronque les plus anciens échanges si l'historique dépasse le budget (le dernier message est toujours gardé).
  const budget = opts.charBudget ?? 24_000;
  let total = turns.reduce((n, m) => n + m.content.length, 0);
  while (turns.length > 1 && total > budget) {
    total -= turns.shift()!.content.length;
  }
  while (turns.length > 1 && turns[0].role === "assistant") turns.shift();
  return [{ role: "system", content: system }, ...turns];
}

export function buildTitlePrompt(firstUserMessage: string, answer: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Tu génères des titres de conversation. Le titre résume le SUJET de la demande de l'utilisateur (pas la réponse), en 2 à 6 mots, dans la langue de l'utilisateur. Réponds uniquement par le titre, sans guillemets, sans ponctuation finale, sans emoji. Exemple : « Combien font 12 x 7 ? » → Calcul de multiplication",
    },
    {
      role: "user",
      content: `Message de l'utilisateur :\n${firstUserMessage.slice(0, 1500)}\n\nDébut de la réponse :\n${answer.slice(0, 600)}\n\nTitre :`,
    },
  ];
}

export function sanitizeTitle(raw: string): string | null {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const cleaned = line
    .replace(/^(titre|title)\s*:\s*/i, "")
    .replace(/^["'«“*#\s]+|["'»”*.\s]+$/g, "")
    .trim();
  if (cleaned.length < 2 || !/\p{L}{2,}/u.test(cleaned)) return null;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
}

export function fallbackTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Nouvelle conversation";
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}…` : oneLine;
}
