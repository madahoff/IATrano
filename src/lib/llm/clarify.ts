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
  // Déduplication et nettoyage des options.
  return {
    questions: parsed.data.questions.map((q) => ({
      question: q.question,
      options: [...new Set(q.options)].slice(0, 6),
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
