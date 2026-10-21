import { z } from "zod";
import { TagSplitter } from "./tag-splitter";

// Demandes de précisions : le modèle peut terminer sa réponse par
//   <clarify>{"questions":[{"question":"…","options":["…","…"]}]}</clarify>
// Le bloc est retiré du texte affiché, validé côté serveur, et ignoré s'il est invalide.

export const clarificationSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(3).max(300),
        options: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
      }),
    )
    .min(1)
    .max(4),
});

export type Clarification = z.infer<typeof clarificationSchema>;

export const CLARIFY_TAG = "clarify";

const PLACEHOLDER_OPTION = /^[\p{L}]+\s*\d+$/u;

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/** Tolère quelques écarts courants des petits modèles (tableau seul, clés au singulier, options en chaîne). */
export function parseClarification(raw: string): Clarification | null {
  const text = stripFences(raw);
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (Array.isArray(data)) data = { questions: data };
  if (data && typeof data === "object" && "question" in data && !("questions" in data)) data = { questions: [data] };
  if (data && typeof data === "object" && Array.isArray((data as { questions?: unknown }).questions)) {
    (data as { questions: unknown[] }).questions = (data as { questions: unknown[] }).questions.map((q) => {
      if (typeof q === "string") return { question: q, options: [] };
      if (q && typeof q === "object") {
        const o = q as Record<string, unknown>;
        const options = o.options ?? o.choices ?? o.suggestions ?? [];
        return {
          question: o.question ?? o.text ?? o.q,
          options: Array.isArray(options) ? options.filter((x) => typeof x === "string") : [],
        };
      }
      return q;
    });
  }
  const parsed = clarificationSchema.safeParse(data);
  if (!parsed.success) return null;
  // Déduplication, suppression des options génériques (« Option 1 », « Destination 2 »…).
  return {
    questions: parsed.data.questions.map((q) => ({
      question: q.question,
      options: [...new Set(q.options)].filter((o) => !PLACEHOLDER_OPTION.test(o)).slice(0, 6),
    })),
  };
}

/** Sépare en streaming le texte affichable du bloc de clarification. */
export function createClarifyExtractor() {
  const splitter = new TagSplitter(CLARIFY_TAG);
  let raw = "";
  return {
    /** Renvoie uniquement le texte destiné à l'utilisateur. */
    push(delta: string): string {
      let visible = "";
      for (const part of splitter.push(delta)) {
        if (part.inside) raw += part.text;
        else visible += part.text;
      }
      return visible;
    },
    /** Fin du flux : texte restant + clarification validée (ou null si absente/invalide). */
    finish(): { text: string; clarification: Clarification | null; malformed: boolean } {
      let visible = "";
      for (const part of splitter.flush()) {
        if (part.inside) raw += part.text;
        else visible += part.text;
      }
      if (splitter.opened === 0) return { text: visible, clarification: null, malformed: false };
      const clarification = parseClarification(raw);
      return { text: visible, clarification, malformed: clarification === null };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Repli pour les petits modèles qui posent leurs questions en texte au lieu d'utiliser <clarify>.
// La DÉCISION est déterministe (heuristique stricte) ; le modèle sert uniquement à structurer
// les questions déjà posées et à proposer des options, via une sortie JSON contrainte par schéma.

const QUESTION_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+.*\?\s*\**\s*$/;

export function looksLikeClarificationRequest(text: string): boolean {
  if (text.length > 1500 || text.includes("```")) return false;
  // Règle 1 : une liste d'au moins deux questions.
  const items = text.split("\n").filter((l) => QUESTION_ITEM.test(l));
  if (items.length >= 2) return true;
  // Règle 2 : réponse courte composée en bonne partie de questions (ex. « Où ? Quand ? Quel budget ? »).
  if (text.length > 800) return false;
  const sentences = text.split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter((x) => x.length > 2);
  const questions = sentences.filter((x) => /\?\s*\**$/.test(x)).length;
  return questions >= 2 && questions / sentences.length >= 0.4;
}

export const CLARIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
} as const;

export function buildClarificationExtractionPrompt(userMessage: string, answer: string) {
  return [
    {
      role: "system" as const,
      content:
        "L'assistant vient de demander des précisions à l'utilisateur. Recopie les questions qu'il a posées (3 au maximum, les plus importantes, formulées brièvement) et propose pour chacune 2 à 5 réponses courtes, concrètes et plausibles que l'utilisateur pourrait choisir. N'invente pas de nouvelles questions. Réponds uniquement en JSON.",
    },
    {
      role: "user" as const,
      content: `Demande de l'utilisateur :\n${userMessage.slice(0, 1500)}\n\nRéponse de l'assistant :\n${answer.slice(0, 1500)}`,
    },
  ];
}
