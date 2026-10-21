import type { Clarification } from "@/lib/chat/protocol";
import type { ChatMessage } from "./types";

export const DEFAULT_SYSTEM_PROMPT = `Tu es IATrano, un assistant IA qui fonctionne localement sur l'infrastructure de l'utilisateur.
Réponds dans la langue de l'utilisateur, de façon exacte, claire et structurée. Utilise le Markdown (titres, listes, tableaux) quand cela aide la lecture, et des blocs de code avec le langage indiqué pour tout code.
Si tu ne sais pas, dis-le plutôt que d'inventer.`;

export const CLARIFICATION_INSTRUCTIONS = `## Demandes de précisions (rarement)
Par défaut, réponds directement. Exception : si la demande est tellement vague qu'une information manquante changerait complètement ta réponse (exemple : « conçois-moi une application » sans plateforme ni objectif), alors :
1. écris une ou deux phrases expliquant ce qu'il te manque, ou propose une première piste ;
2. termine ton message par exactement un bloc de ce format, et rien après :
<clarify>{"questions":[{"question":"Quelle plateforme vises-tu ?","options":["Web","Mobile","Desktop"]}]}</clarify>
Règles : JSON valide, 1 à 3 questions, 2 à 5 options courtes par question.
N'utilise JAMAIS ce bloc pour une question claire, factuelle ou une conversation courante, ni quand tu peux raisonnablement répondre, ni juste après que l'utilisateur a répondu à tes questions.`;

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
        "Tu génères des titres de conversation. Réponds uniquement par un titre de 2 à 6 mots, dans la langue de l'utilisateur, sans guillemets, sans ponctuation finale, sans emoji.",
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
  if (cleaned.length < 2) return null;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
}

export function fallbackTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Nouvelle conversation";
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}…` : oneLine;
}
