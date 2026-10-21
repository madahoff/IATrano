// Types et schémas partagés client/serveur de la recherche Web (aucun import serveur).
// Les événements de recherche reçus par le navigateur sont validés avec ces schémas avant affichage.
import { z } from "zod";

export const STEP_KINDS = [
  "analyze",
  "queries",
  "search",
  "fetch",
  "select",
  "context",
  "generate",
] as const;

export const stepStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepItemSchema = z.object({
  url: z.string().max(2048),
  title: z.string().max(300).optional(),
  host: z.string().max(255),
  status: stepStatusSchema,
  note: z.string().max(300).optional(),
});
export type StepItem = z.infer<typeof stepItemSchema>;

export const researchStepSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(STEP_KINDS),
  label: z.string().max(200),
  detail: z.string().max(500).optional(),
  status: stepStatusSchema,
  count: z.number().int().nonnegative().optional(),
  items: z.array(stepItemSchema).max(30).optional(),
});
export type ResearchStep = z.infer<typeof researchStepSchema>;

/** Niveau de complétude du contenu d'une source. */
export const contentLevelSchema = z.enum(["full", "partial", "snippet"]);

export const sourceSchema = z.object({
  /** Identifiant stable de la source dans la réponse : le marqueur [n] du texte. */
  n: z.number().int().min(1).max(99),
  url: z.string().max(2048),
  title: z.string().max(300),
  host: z.string().max(255),
  siteName: z.string().max(120).nullable(),
  favicon: z.string().max(2048).nullable(),
  publishedAt: z.string().max(40).nullable(),
  accessedAt: z.string().max(40),
  snippet: z.string().max(600),
  content: contentLevelSchema,
  /** Source primaire probable (site officiel, documentation de l'éditeur…). Heuristique. */
  primary: z.boolean(),
  /** true si le contenu provient du cache de la même instance (pas d'une consultation immédiate). */
  cached: z.boolean(),
});
export type SourceDTO = z.infer<typeof sourceSchema>;

export const researchModeSchema = z.enum(["auto", "explicit", "deep"]);
export type ResearchMode = z.infer<typeof researchModeSchema>;

export const researchStatusSchema = z.enum(["running", "done", "failed", "cancelled"]);
export type ResearchStatus = z.infer<typeof researchStatusSchema>;

export type ResearchDTO = {
  mode: ResearchMode;
  status: ResearchStatus;
  queries: string[];
  steps: ResearchStep[];
  sources: SourceDTO[];
  /** Numéros cités et validés par le serveur ; null tant que la réponse n'est pas terminée. */
  cited: number[] | null;
  limitations: string[];
  error: string | null;
  durationMs: number | null;
};

// --- Événements de streaming liés à la recherche (inclus dans StreamEvent, voir chat/protocol.ts)

export const researchEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("research_start"), mode: researchModeSchema, reason: z.string().max(300) }),
  z.object({ type: z.literal("research_step"), seq: z.number().int().nonnegative(), step: researchStepSchema }),
  z.object({ type: z.literal("research_sources"), sources: z.array(sourceSchema).max(20) }),
  z.object({
    type: z.literal("research_end"),
    status: researchStatusSchema,
    queries: z.array(z.string().max(300)).max(6),
    limitations: z.array(z.string().max(400)).max(20),
    error: z.string().max(500).nullable(),
  }),
  z.object({
    type: z.literal("citations"),
    /** Texte final, débarrassé des références invalides. Remplace le texte reçu en streaming. */
    content: z.string(),
    cited: z.array(z.number().int().min(1).max(99)).max(20),
    removed: z.number().int().nonnegative(),
  }),
]);
export type ResearchEvent = z.infer<typeof researchEventSchema>;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
