import { z } from "zod";
import type { ChatMessage } from "@/lib/llm/types";

// Extraction de souvenirs à partir d'un échange. Tout ce qui est dit ne devient pas une mémoire :
// l'extraction ne se déclenche que sur des formulations explicites (« retiens que », « je préfère »,
// « appelle-moi », « oublie que », corrections « en fait… »), puis la sortie du modèle est validée
// côté serveur (format, longueur, données sensibles, doublons) avant toute écriture.

const CUES = [
  /\b(souviens[- ]toi|rappelle[- ]toi|retiens|m[ée]morise|garde (?:[çc]a |cela )?en (?:m[ée]moire|t[eê]te)|n'oublie pas|note (?:bien )?que|pour (?:la|les) prochaines? fois)\b/i,
  /\b(oublie (?:que|ce|cette|mon|ma|mes)|ne retiens pas|efface (?:de ta|la) m[ée]moire)\b/i,
  /\b(je (?:pr[ée]f[èe]re|veux toujours|d[ée]teste|n'aime pas)|appelle[- ]moi|mon (?:pr[ée]nom|nom) est|je m'appelle|tutoie[- ]moi|vouvoie[- ]moi)\b/i,
  /\b(d[ée]sormais|[àa] partir de maintenant|dor[ée]navant|toujours r[ée]pondre|r[ée]ponds(?:-moi)? toujours)\b/i,
  /\b(je travaille (?:sur|chez|comme|avec)|mon projet|notre projet|je suis (?:d[ée]veloppeur|d[ée]veloppeuse|[ée]tudiant|[ée]tudiante|ing[ée]nieur|enseignant|m[ée]decin))\b/i,
  /\b(en fait|correction|je me suis tromp[ée]|ce n'est (?:plus|pas) (?:vrai|exact))\b.*\b(je|mon|ma|mes)\b/i,
  /\b(remember|don't forget|from now on|i prefer|call me|my name is|forget that)\b/i,
];

export function hasMemoryCue(text: string): boolean {
  return CUES.some((r) => r.test(text));
}

export const MEMORY_ACTIONS_JSON_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "update", "delete"] },
          ref: { type: "string" },
          kind: { type: "string", enum: ["PREFERENCE", "FACT", "PROJECT"] },
          project: { type: "string" },
          content: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  required: ["actions"],
} as const;

const actionSchema = z.object({
  action: z.enum(["add", "update", "delete"]),
  ref: z.string().optional(),
  kind: z.enum(["PREFERENCE", "FACT", "PROJECT"]).optional(),
  project: z.string().optional(),
  content: z.string().optional(),
});

export type MemoryAction =
  | { action: "add"; kind: "PREFERENCE" | "FACT" | "PROJECT"; project: string | null; content: string }
  | { action: "update"; id: string; content: string }
  | { action: "delete"; id: string };

/** Demande explicite de mémoriser ou d'oublier (le modèle doit alors produire une action). */
const EXPLICIT = /\b(souviens[- ]toi|rappelle[- ]toi|retiens|m[ée]morise|garde (?:[çc]a |cela )?en (?:m[ée]moire|t[eê]te)|n'oublie pas|oublie|ne retiens pas|appelle[- ]moi|d[ée]sormais|[àa] partir de maintenant|dor[ée]navant|remember|forget|from now on|call me)\b/i;

export function isExplicitMemoryRequest(text: string): boolean {
  return EXPLICIT.test(text);
}

export function buildMemoryExtractionPrompt(
  userMessage: string,
  answer: string,
  existing: Array<{ ref: string; kind: string; project: string | null; content: string }>,
): ChatMessage[] {
  const list = existing.length
    ? existing.map((m) => `${m.ref} [${m.kind}${m.project ? ` · ${m.project}` : ""}] ${m.content}`).join("\n")
    : "(aucun)";
  const explicit = isExplicitMemoryRequest(userMessage);
  return [
    {
      role: "system",
      content: `Tu mets à jour la mémoire à long terme d'un assistant à partir du message de l'utilisateur. Réponds en JSON : {"actions": [...]}.
Actions possibles :
- {"action":"add","kind":"PREFERENCE"|"FACT"|"PROJECT","project":"nom si PROJECT","content":"phrase courte"}
- {"action":"update","ref":"M1","content":"nouvelle phrase"} quand le message corrige un souvenir existant
- {"action":"delete","ref":"M1"} quand l'utilisateur demande d'oublier
Règles : "content" est une phrase courte à la troisième personne commençant par « L'utilisateur ». PREFERENCE = consigne ou préférence, FACT = fait durable sur l'utilisateur, PROJECT = projet nommé. Jamais de mot de passe, de clé ni de donnée bancaire. Ignore les questions ponctuelles et les informations temporaires.

Exemples :
Message : « Retiens que je code en Python. » → {"actions":[{"action":"add","kind":"FACT","content":"L'utilisateur code en Python."}]}
Message : « Désormais réponds-moi en anglais. » → {"actions":[{"action":"add","kind":"PREFERENCE","content":"L'utilisateur veut des réponses en anglais."}]}
Message : « Oublie que j'habite à Lyon. » avec M2 = « L'utilisateur habite à Lyon. » → {"actions":[{"action":"delete","ref":"M2"}]}
Message : « En fait j'utilise PostgreSQL, pas MySQL. » avec M1 = « L'utilisateur utilise MySQL. » → {"actions":[{"action":"update","ref":"M1","content":"L'utilisateur utilise PostgreSQL."}]}
Message : « Quelle heure est-il ? » → {"actions":[]}`,
    },
    {
      role: "user",
      content: `Souvenirs existants :\n${list}\n\nMessage de l'utilisateur :\n${userMessage.slice(0, 2000)}\n\n${
        explicit ? "L'utilisateur demande explicitement de mémoriser, corriger ou oublier quelque chose : produis l'action correspondante." : "Ne produis une action que si le message contient une information durable sur l'utilisateur."
      }`,
    },
  ];
}

/** Valide la sortie du modèle et la traduit en actions sur des identifiants réels de l'utilisateur. */
export function parseMemoryActions(raw: string, refs: Map<string, string>): MemoryAction[] {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return [];
  }
  const list = (data as { actions?: unknown })?.actions;
  if (!Array.isArray(list)) return [];
  const out: MemoryAction[] = [];
  for (const item of list.slice(0, 3)) {
    const parsed = actionSchema.safeParse(item);
    if (!parsed.success) continue;
    const a = parsed.data;
    const content = a.content?.replace(/\s+/g, " ").trim() ?? "";
    const id = a.ref ? refs.get(a.ref.trim().toUpperCase()) : undefined;
    if (a.action === "delete") {
      if (id) out.push({ action: "delete", id });
    } else if (a.action === "update" && id) {
      if (content.length >= 5 && content.length <= 300) out.push({ action: "update", id, content });
    } else if (content.length >= 5 && content.length <= 300) {
      // Ajout, ou « mise à jour » d'un souvenir inexistant (erreur fréquente des petits modèles) traitée comme un ajout.
      const kind = a.kind ?? "FACT";
      const project = kind === "PROJECT" ? a.project?.trim() || null : null;
      out.push({ action: "add", kind: kind === "PROJECT" && !project ? "FACT" : kind, project, content });
    }
  }
  return out;
}
