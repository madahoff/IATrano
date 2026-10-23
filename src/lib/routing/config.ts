import { z } from "zod";

// Configuration du routage par JEV, partagée entre serveur et navigateur.
// Les questions sont en anglais : le modèle JEV est entraîné en anglais.

export const ROUTING_MODES = ["thinking", "research", "interactive"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const AUTH_MODES = ["AUTO", "MANUAL", "HYBRID", "OFF"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Règle d'administration par mode. */
export const MODE_RULES = ["ALLOWED", "FORBIDDEN", "CONFIRM"] as const;
export type ModeRule = (typeof MODE_RULES)[number];

export type ModeConfig = { question: string; threshold: number; rule: ModeRule };
export type ModesConfig = Record<RoutingMode, ModeConfig>;

export const MODE_LABELS: Record<RoutingMode, string> = {
  thinking: "Réflexion approfondie",
  research: "Recherche web",
  interactive: "Interactif",
};
export const MODE_SHORT: Record<RoutingMode, string> = { thinking: "Réflexion", research: "Recherche", interactive: "Interactif" };

export const MODE_HELP: Record<RoutingMode, string> = {
  thinking: "Qwen réfléchit étape par étape avant de répondre : plus lent, mais plus fiable pour les calculs, la logique ou les choix complexes.",
  research: "IATrano cherche sur le Web, transmet les pages trouvées à Qwen et affiche les sources sous la réponse.",
  interactive: "Qwen ajoute une petite page interactive (schéma, simulation, calculateur) pour illustrer la réponse.",
};

export const AUTH_MODE_LABELS: Record<AuthMode, string> = {
  AUTO: "Automatique",
  MANUAL: "Manuel",
  HYBRID: "Hybride",
  OFF: "Désactivé",
};

export const AUTH_MODE_HELP: Record<AuthMode, string> = {
  AUTO: "JEV choisit les modes et IATrano les applique directement. Les modes utilisés restent affichés au-dessus de la réponse.",
  MANUAL: "JEV propose des modes ; vous validez chaque proposition avant que Qwen ne réponde.",
  HYBRID: "Activation directe quand JEV est très sûr de lui, confirmation demandée quand il hésite.",
  OFF: "JEV n'est pas consulté : vous activez vous-même les modes dans le panneau « Options » sous le champ de saisie.",
};

export const DEFAULT_THRESHOLD = 0.6;
export const DEFAULT_HIGH_THRESHOLD = 0.85;

export const DEFAULT_MODES: ModesConfig = {
  thinking: {
    question: "Does this request need careful step-by-step reasoning, such as math, logic, planning, comparison or a complex decision?",
    threshold: DEFAULT_THRESHOLD,
    rule: "ALLOWED",
  },
  research: {
    question: "Does answering this request require recent or external information that a language model may not know?",
    threshold: DEFAULT_THRESHOLD,
    rule: "ALLOWED",
  },
  interactive: {
    question: "Would an interactive visual (diagram, simulation, calculator, timeline or step-by-step explainer) make the answer much clearer?",
    threshold: DEFAULT_THRESHOLD,
    rule: "ALLOWED",
  },
};

const threshold = z.number({ message: "Le seuil doit être un nombre." }).min(0, "Les seuils sont compris entre 0 et 1.").max(1, "Les seuils sont compris entre 0 et 1.");

export const modeConfigSchema = z.object({
  question: z.string().trim().min(10, "Chaque question doit faire au moins 10 caractères.").max(600, "Question trop longue (600 caractères max)."),
  threshold,
  rule: z.enum(MODE_RULES),
});

export const modesConfigSchema = z.object({
  thinking: modeConfigSchema,
  research: modeConfigSchema,
  interactive: modeConfigSchema,
});

export const routingSettingsSchema = z
  .object({
    modes: modesConfigSchema,
    defaultAuthMode: z.enum(AUTH_MODES),
    highThreshold: threshold,
    fallbackModes: z.array(z.enum(ROUTING_MODES)).max(3),
    includeContext: z.boolean(),
  })
  .superRefine((v, ctx) => {
    for (const m of ROUTING_MODES) {
      if (v.highThreshold < v.modes[m].threshold) {
        ctx.addIssue({ code: "custom", path: ["highThreshold"], message: `Le seuil haut du mode hybride (${v.highThreshold}) doit être supérieur ou égal au seuil de « ${MODE_LABELS[m]} » (${v.modes[m].threshold}).` });
        return;
      }
    }
  });

export type RoutingSettingsInput = z.infer<typeof routingSettingsSchema>;

export const ROUTING_FACTORY_DEFAULTS: RoutingSettingsInput = {
  modes: DEFAULT_MODES,
  defaultAuthMode: "HYBRID",
  highThreshold: DEFAULT_HIGH_THRESHOLD,
  fallbackModes: [],
  includeContext: true,
};

/** Lecture tolérante de la colonne JSON : toute valeur absente ou invalide reprend la valeur par défaut. */
export function parseModesConfig(raw: unknown): ModesConfig {
  const out = {} as ModesConfig;
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const m of ROUTING_MODES) {
    const parsed = modeConfigSchema.safeParse(obj[m]);
    out[m] = parsed.success ? parsed.data : DEFAULT_MODES[m];
  }
  return out;
}

/** Messages d'exemple du test de routage, avec le mode attendu (indicatif). */
export const ROUTING_SAMPLES: Array<{ label: string; message: string; expected: RoutingMode[] }> = [
  { label: "Question simple", message: "Comment dit-on « merci » en anglais ?", expected: [] },
  {
    label: "Problème de logique",
    message: "Trois amis se partagent 48 €. Chacun reçoit 4 € de plus que le précédent. Combien reçoit chacun ? Explique ton raisonnement.",
    expected: ["thinking"],
  },
  { label: "Question d'actualité", message: "Quels sont les résultats du dernier match de l'équipe de France de football cette semaine ?", expected: ["research"] },
];
