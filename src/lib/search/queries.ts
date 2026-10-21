// Formulation des requêtes envoyées au moteur de recherche : par le modèle (sortie JSON validée),
// avec repli déterministe. Les données personnelles évidentes sont retirées avant tout envoi.
import { z } from "zod";
import type { ChatMessage } from "@/lib/llm/types";
import type { ResearchMode } from "./research-types";
import { fold } from "./text";

const MAX_QUERY_LEN = 120;

/** Retire e-mails, numéros de téléphone/carte/IBAN, jetons et secrets d'une requête. */
export function redactQuery(q: string): string {
  return q
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, " ")
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/gi, " ") // IBAN
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp]|AKIA|eyJ)[-_A-Za-z0-9.]{12,}\b/g, " ") // clés d'API, JWT
    .replace(/\b(mot de passe|password|passwd|pwd|token|secret|api[ -]?key|cl[ée] d'?api)\s*[:=]?\s*\S+/gi, " ")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => (/^(19|20)\d{2}$/.test(m.trim()) ? m : " ")) // téléphones, cartes
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, " ") // longues chaînes aléatoires
    .replace(/\s+/g, " ")
    .trim();
}

const FILLER = /\b(est-ce que|peux-tu|pourrais-tu|pouvez-vous|pourriez-vous|stp|s'il te pla[iî]t|s'il vous pla[iî]t|merci|dis-moi|explique-moi|cherche(r)?|recherche(r)?|fais une recherche|regarde|v[ée]rifie|sur internet|sur le web|en ligne|sur google|avec des sources|avec sources|cite tes sources|please|can you|could you|search the web for|search for|look up)\b/gi;

/** Requête déterministe tirée du message (repli si le modèle échoue). */
export function fallbackQuery(message: string): string {
  const cleaned = redactQuery(message)
    .replace(FILLER, " ")
    .replace(/[«»"“”?!¿¡:;()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 14);
  return words.join(" ").slice(0, MAX_QUERY_LEN) || redactQuery(message).slice(0, MAX_QUERY_LEN);
}

export const QUERY_JSON_SCHEMA = {
  type: "object",
  properties: { queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } },
  required: ["queries"],
} as const;

const querySchema = z.object({ queries: z.array(z.string()).min(1).max(5) });

export function maxQueries(mode: ResearchMode): number {
  return mode === "deep" ? 3 : 2;
}

export function buildQueryPrompt(opts: { message: string; context: string | null; mode: ResearchMode; timeSensitive: boolean; now: Date }): ChatMessage[] {
  const n = maxQueries(opts.mode);
  return [
    {
      role: "system",
      content: [
        "Tu prépares des requêtes pour un moteur de recherche Web.",
        `Produis 1 à ${n} requêtes courtes (3 à 10 mots), précises, avec les noms propres, produits et versions exacts de la question.`,
        n > 1 ? "Si la question a plusieurs aspects, une requête par aspect. Sinon une seule requête." : "",
        opts.timeSensitive ? `Information récente : ajoute l'année ${opts.now.getFullYear()} si c'est utile.` : "",
        "N'inclus aucune donnée personnelle (nom privé, e-mail, numéro).",
        'Réponds uniquement en JSON : {"queries":["..."]}',
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "user",
      content: `${opts.context ? `Contexte de la conversation :\n${opts.context.slice(0, 800)}\n\n` : ""}Question :\n${opts.message.slice(0, 1200)}`,
    },
  ];
}

/** Valide la sortie du modèle et la complète par la requête de repli. Ne lève jamais. */
export function parseQueries(raw: string | null, message: string, mode: ResearchMode): { queries: string[]; fromModel: boolean } {
  const fallback = fallbackQuery(message);
  let fromModel: string[] = [];
  if (raw) {
    try {
      const parsed = querySchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        fromModel = parsed.data.queries
          .map((q) => redactQuery(q).replace(/^["'\s]+|["'\s]+$/g, "").slice(0, MAX_QUERY_LEN))
          .filter((q) => q.length >= 3 && /\p{L}/u.test(q));
      }
    } catch {
      // JSON invalide : repli
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of [...fromModel, fallback]) {
    const key = fold(q).replace(/\W+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= maxQueries(mode)) break;
  }
  return { queries: out.length ? out : [fallback], fromModel: fromModel.length > 0 };
}
