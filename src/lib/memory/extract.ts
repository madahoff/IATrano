import { z } from "zod";
import type { ChatMessage } from "@/lib/llm/types";
import { normalizeWords } from "./select";
import { ADDRESS_TOPIC, NAME_TOPIC, normalizeTopic, RESPONSE_LANGUAGE_TOPIC, responseLanguage, topicFor } from "./topics";
import { MEMORY_KINDS, type MemoryCandidate, type MemoryKindValue } from "./types";

// Memory Extraction : repère dans un message de l'utilisateur ce qui peut mériter d'être mémorisé.
//
// 1. Seul le texte écrit par l'utilisateur est analysé : citations (« > »), blocs de code et documents collés
//    sont retirés — leur contenu ne vaut jamais instruction de mémorisation.
// 2. Un filtre déterministe écarte sans appel au modèle les messages sans indice de durabilité
//    (questions ordinaires, demandes ponctuelles).
// 3. Des règles traitent directement les cas fréquents et sans ambiguïté (« oublie que… », « je préfère X plutôt
//    que Y », « réponds-moi toujours en anglais », « tutoie-moi », « appelle-moi… »).
// 4. Le reste est confié au modèle, dont chaque proposition doit citer un extrait réel du message (preuve) :
//    une supposition du modèle ne peut pas devenir un souvenir.

const MAX_ANALYZED_CHARS = 3000;

/** Texte réellement rédigé par l'utilisateur : sans citations, blocs de code ni documents collés. */
export function userAuthoredText(text: string): string {
  let t = text
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/<(project_documents|document|documents|artifact|file|pasted|quote)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi, "\n")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    // Longs passages entre guillemets : texte cité, pas une déclaration de l'utilisateur.
    .replace(/«[^»]{80,}»|"[^"\n]{80,}"|“[^”]{80,}”/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length > MAX_ANALYZED_CHARS) t = `${t.slice(0, MAX_ANALYZED_CHARS / 2)}\n…\n${t.slice(-MAX_ANALYZED_CHARS / 2)}`;
  return t;
}

const REMEMBER =
  /\b(retiens|souviens[- ]toi|rappelle[- ]toi (?:que|de|bien)|m[ée]morise|garde (?:[çc]a |cela |le |la |bien )?en (?:m[ée]moire|t[eê]te)|n'oublie pas (?:que|[çc]a|cela|mon|ma|mes)|note (?:bien )?(?:que|[çc]a)|pour (?:la|les) prochaines? fois|[àa] l'avenir|remember|keep in mind|don't forget)\b/i;

// Impératif en début de phrase (« Oublie que… ») : « j'oublie toujours mes clés » n'est pas une demande.
const FORGET_LEAD = String.raw`(?:^|[.!?;:\n]\s*|\b(?:et|alors|stp|svp|merci d'|merci de)\s+)`;
const FORGET = new RegExp(
  `${FORGET_LEAD}(?:(?:tu peux|peux-tu|pourrais-tu|merci d')\\s*)?(?:oublie(?:r)?|efface(?:r)? de ta m[ée]moire|supprime(?:r)? de ta m[ée]moire|ne retiens (?:plus|pas)|ne te souviens plus|forget)\\b\\s*(?:que\\s+|qu'|about\\s+|that\\s+)?([^.!?\\n]*)`,
  "gi",
);

const CUES = [
  /\b(je (?:pr[ée]f[èe]re|veux (?:toujours|que tu)|d[ée]teste|n'aime pas|aime (?:mieux|bien|pas))|j'aime (?:mieux|bien|pas)|plut[ôo]t que|au lieu de|[àa] la place de)\b/i,
  /\b(appelle[- ]moi|mon (?:pr[ée]nom|nom) (?:est|c'est)|je m'appelle|tutoie[- ]moi|vouvoie[- ]moi|tu peux me (?:tutoyer|vouvoyer))\b/i,
  /\b(d[ée]sormais|[àa] partir de maintenant|dor[ée]navant|par d[ée]faut|toujours r[ée]pondre|r[ée]ponds(?:-moi)? toujours|ne (?:jamais|plus jamais))\b/i,
  /\b(j'utilise|je n'utilise (?:pas|plus|jamais)|on utilise|nous utilisons|on n'utilise|j'ai (?:choisi|d[ée]cid[ée]|adopt[ée])|on a (?:choisi|d[ée]cid[ée]|opt[ée])|nous avons (?:choisi|d[ée]cid[ée])|on part sur|je pars sur|je code en|je d[ée]veloppe (?:en|avec|sous)|je d[ée]ploie)\b/i,
  /\b(je travaille (?:sur|chez|comme|avec|en|dans|pour)|je bosse|mon (?:m[ée]tier|r[ôo]le|poste|travail|entreprise|[ée]quipe|objectif|but)|ma (?:soci[ée]t[ée]|startup|stack|mission)|je suis (?:un |une )?(?:d[ée]veloppeu(?:r|se)|[ée]tudiant|[ée]tudiante|ing[ée]nieur|enseignant|enseignante|professeur|m[ée]decin|designer|chef de projet|freelance|ind[ée]pendant|consultant|consultante|data scientist|administrateur|devops|graphiste|entrepreneur)|j'habite|je vis [àa]|je cherche [àa]|mon objectif)\b/i,
  /\b(mon projet|notre projet|ce projet|le projet [A-Z]|notre stack|l'architecture|notre architecture|la convention|nos conventions|la r[èe]gle (?:est|c'est)|il faut toujours|on ne doit (?:jamais|pas)|contrainte|l'objectif (?:du|de ce) projet)\b/i,
  /\b(en fait|correction|je me suis tromp[ée]|ce n'est (?:plus|pas) (?:vrai|exact)|j'ai chang[ée]|je suis pass[ée] [àa]|maintenant j'utilise)\b/i,
  /\b(i prefer|i always|call me|my name is|i use|we use|i work (?:on|at|as)|from now on|always answer|our project|my project)\b/i,
];

const HEDGED = /\b(peut[- ][êe]tre|je pense (?:que|passer|utiliser|migrer)|probablement|sans doute|j'envisage|je songe|il se peut|je ne suis pas s[ûu]r|pas encore d[ée]cid[ée]|j'h[ée]site|maybe|probably|thinking about)\b/i;

export type MemorySignal = { potential: boolean; explicitRemember: boolean; explicitForget: boolean; hedged: boolean };

/** Filtre déterministe : le message contient-il un indice d'information durable, une demande de retenir ou d'oublier ? */
export function assessMemoryPotential(userText: string): MemorySignal {
  const explicitRemember = REMEMBER.test(userText);
  FORGET.lastIndex = 0;
  const explicitForget = FORGET.test(userText);
  FORGET.lastIndex = 0;
  const potential = explicitRemember || explicitForget || CUES.some((r) => r.test(userText));
  return { potential, explicitRemember, explicitForget, hedged: HEDGED.test(userText) };
}

/** Compatibilité : vrai si le message mérite une analyse de la mémoire. */
export function hasMemoryCue(text: string): boolean {
  return assessMemoryPotential(userAuthoredText(text)).potential;
}

export function isExplicitMemoryRequest(text: string): boolean {
  const s = assessMemoryPotential(text);
  return s.explicitRemember || s.explicitForget;
}

// ---------------------------------------------------------------------------
// Règles déterministes
// ---------------------------------------------------------------------------

const DURABLE = /\b(toujours|d[ée]sormais|dor[ée]navant|[àa] partir de maintenant|[àa] l'avenir|par d[ée]faut|syst[ée]matiquement|always|from now on)\b/i;

function sentences(text: string) {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const clip = (s: string) => s.replace(/^[\s,:;«"“]+|[\s,.;:!?»"”]+$/g, "").trim();
const shortTerm = (s: string) => s.length > 0 && s.length <= 60 && s.split(/\s+/).length <= 6;
const sentence = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

function candidate(c: Omit<MemoryCandidate, "origin" | "project" | "scope"> & { scope?: MemoryCandidate["scope"] }): MemoryCandidate {
  return { scope: "personal", project: null, origin: "rules", ...c };
}

/** Une phrase → au plus une information reconnue par règle (null si aucune règle ne s'applique). */
function ruleForSentence(s: string, durableMessage: boolean): MemoryCandidate | null {
  // « je préfère X plutôt que Y », « j'utilise X au lieu de Y », « utilise X plutôt que Y »
  const pref = s.match(
    /\b(je pr[ée]f[èe]re|j'utilise|utilise|on utilise|nous utilisons)\s+(?:utiliser\s+|travailler (?:avec|en|sous)\s+|coder en\s+|qu'on utilise\s+|que tu utilises\s+)?(.+?)\s+(?:plut[ôo]t que|au lieu de|[àa] la place de)\s+(?:d'utiliser\s+|utiliser\s+)?(.+)$/i,
  );
  if (pref) {
    const [, verb, a, b] = pref;
    const x = clip(a);
    const y = clip(b);
    if (shortTerm(x) && shortTerm(y)) {
      const v = verb.toLowerCase();
      const content = v.startsWith("je") ? `L'utilisateur préfère ${x} plutôt que ${y}.` : v === "utilise" ? `L'utilisateur veut que l'on utilise ${x} plutôt que ${y}.` : `L'utilisateur utilise ${x} plutôt que ${y}.`;
      return candidate({ kind: "PREFERENCE", topic: topicFor(x, y), content, evidence: s, certainty: "STATED", importance: 4 });
    }
  }
  // « je préfère pnpm à npm » : seulement entre deux outils connus de la même catégorie (« à » est trop ambigu sinon).
  const versus = s.match(/\bje pr[ée]f[èe]re\s+([\p{L}\d.#+-]+)\s+[àa]\s+([\p{L}\d.#+-]+)\s*[.!]?$/iu);
  if (versus) {
    const topic = topicFor(versus[1]);
    if (topic && topic === topicFor(versus[2])) {
      return candidate({ kind: "PREFERENCE", topic, content: `L'utilisateur préfère ${versus[1]} à ${versus[2]}.`, evidence: s, certainty: "STATED", importance: 4 });
    }
  }
  // « réponds-moi toujours en anglais » (durable seulement : « réponds en anglais à cette question » est ponctuel)
  const lang = s.match(/\b(?:r[ée]ponds?(?:-moi)?|parle(?:-moi)?|[ée]cris(?:-moi)?|answer)\b[^.]*?\ben\s+([\p{L}]+)/iu);
  if (lang && (durableMessage || DURABLE.test(s))) {
    const l = responseLanguage(lang[1]);
    if (l) return candidate({ kind: "PREFERENCE", topic: RESPONSE_LANGUAGE_TOPIC, content: `L'utilisateur veut des réponses en ${l}.`, evidence: s, certainty: "STATED", importance: 4 });
  }
  if (/\b(tutoie[- ]moi|tu peux me tutoyer)\b/i.test(s)) {
    return candidate({ kind: "PREFERENCE", topic: ADDRESS_TOPIC, content: "L'utilisateur veut être tutoyé.", evidence: s, certainty: "STATED", importance: 3 });
  }
  if (/\b(vouvoie[- ]moi|tu peux me vouvoyer)\b/i.test(s)) {
    return candidate({ kind: "PREFERENCE", topic: ADDRESS_TOPIC, content: "L'utilisateur veut être vouvoyé.", evidence: s, certainty: "STATED", importance: 3 });
  }
  // Prénom avec majuscule (« appelle-moi demain » n'est pas un prénom).
  const name = s.match(/\b([Aa]ppelle[- ]moi|[Jj]e m'appelle|[Mm]on pr[ée]nom (?:est|c'est)|[Cc]all me|[Mm]y name is)\s+([\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+)?)/u);
  if (name) {
    const called = /appelle|call/i.test(name[1]);
    return candidate({
      kind: "FACT",
      topic: NAME_TOPIC,
      content: called ? `L'utilisateur veut être appelé ${name[2]}.` : `L'utilisateur s'appelle ${name[2]}.`,
      evidence: s,
      certainty: "STATED",
      importance: 4,
    });
  }
  return null;
}

export type RuleExtraction = {
  candidates: MemoryCandidate[];
  /** Ce que l'utilisateur demande d'oublier (texte libre, rapproché des souvenirs existants). */
  forget: string[];
  /** Toutes les phrases porteuses d'information ont été traitées : l'appel au modèle est inutile. */
  covered: boolean;
};

export function extractByRules(userText: string): RuleExtraction {
  const forget: string[] = [];
  FORGET.lastIndex = 0;
  for (const m of userText.matchAll(FORGET)) {
    const q = clip(m[1] ?? "");
    if (q.length >= 3) forget.push(q);
  }
  FORGET.lastIndex = 0;
  const durable = DURABLE.test(userText) || REMEMBER.test(userText);
  const candidates: MemoryCandidate[] = [];
  let covered = true;
  for (const s of sentences(userText)) {
    FORGET.lastIndex = 0;
    const isForget = FORGET.test(s);
    FORGET.lastIndex = 0;
    if (isForget) continue;
    const c = ruleForSentence(s, durable);
    if (c) candidates.push(c);
    else if (assessMemoryPotential(s).potential) covered = false;
  }
  return { candidates, forget, covered };
}

const IRREGULAR: Record<string, string> = {
  suis: "est",
  ai: "a",
  vais: "va",
  fais: "fait",
  peux: "peut",
  veux: "veut",
  dois: "doit",
  sais: "sait",
  vis: "vit",
  connais: "connaît",
  prends: "prend",
  mets: "met",
  écris: "écrit",
  lis: "lit",
  crois: "croit",
  viens: "vient",
  tiens: "tient",
  pars: "part",
  sors: "sort",
};

/**
 * « je travaille chez Acme » → « L'utilisateur travaille chez Acme. » Renvoie null dès que la transposition
 * n'est pas sûre (tutoiement, « nous », compléments à la première personne).
 */
export function toThirdPerson(text: string): string | null {
  const t = clip(text);
  if (!t || /\b(tu|te|toi|ton|ta|tes|vous|votre|vos|nous|notre|nos|on|me|moi)\b|\bm'/i.test(t.replace(/^(je|j')\s*/i, ""))) return null;
  const m = t.match(/^(?:je\s+(\S+)|j'(\S+))(.*)$/i);
  if (!m) return null;
  const verb = (m[1] ?? m[2]).toLowerCase();
  const third = IRREGULAR[verb] ?? (verb.endsWith("e") ? verb : verb.endsWith("s") ? `${verb.slice(0, -1)}t` : null);
  if (!third) return null;
  const rest = m[3].replace(/\bmon\b/gi, "son").replace(/\bma\b/gi, "sa").replace(/\bmes\b/gi, "ses");
  return sentence(`L'utilisateur ${third}${rest}`);
}

/** Phrases introduites par « retiens que… » : utilisées si le modèle reste indisponible (la demande n'est jamais perdue). */
export function explicitRememberFallback(userText: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  for (const s of sentences(userText)) {
    const m = s.match(/\b(?:retiens|souviens[- ]toi|rappelle[- ]toi|m[ée]morise|note bien|note|garde en m[ée]moire|garde en t[eê]te|n'oublie pas|remember|keep in mind)\s*(?:bien\s+)?(?:que\s+|qu'|:\s*|that\s+)(.+)$/i);
    if (!m) continue;
    const what = clip(m[1]);
    if (what.length < 3) continue;
    const content = toThirdPerson(what) ?? `L'utilisateur a demandé de retenir : « ${what.slice(0, 240)} ».`;
    out.push({ kind: "FACT", scope: "personal", project: null, topic: null, content, evidence: s, certainty: "CONFIRMED", importance: 4, origin: "fallback" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction par le modèle
// ---------------------------------------------------------------------------

export const MEMORY_ACTIONS_JSON_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "update", "delete"] },
          ref: { type: "string" },
          scope: { type: "string", enum: ["personal", "project"] },
          kind: { type: "string", enum: [...MEMORY_KINDS] },
          project: { type: "string" },
          topic: { type: "string" },
          content: { type: "string" },
          evidence: { type: "string" },
          certainty: { type: "string", enum: ["stated", "uncertain"] },
          importance: { type: "integer", minimum: 1, maximum: 5 },
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
  scope: z.enum(["personal", "project"]).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  project: z.string().optional(),
  topic: z.string().optional(),
  content: z.string().optional(),
  evidence: z.string().optional(),
  certainty: z.enum(["stated", "uncertain"]).optional(),
  importance: z.number().optional(),
});

export type MemoryAction =
  | { action: "add"; candidate: MemoryCandidate }
  | { action: "update"; id: string; candidate: MemoryCandidate }
  | { action: "delete"; id: string };

export type ExistingMemoryRef = { ref: string; scope: "personal" | "project"; kind: string; project: string | null; topic: string | null; content: string };

export function buildMemoryExtractionPrompt(userText: string, existing: ExistingMemoryRef[], ctx: { projectName: string | null; explicit: boolean }): ChatMessage[] {
  const list = existing.length
    ? existing.map((m) => `${m.ref} [${m.scope === "project" ? "projet" : "personnel"} · ${m.kind}${m.project ? ` · ${m.project}` : ""}${m.topic ? ` · sujet ${m.topic}` : ""}] ${m.content}`).join("\n")
    : "(aucun)";
  return [
    {
      role: "system",
      content: `Tu tiens à jour la mémoire à long terme d'un assistant à partir d'UN message de l'utilisateur. Réponds uniquement en JSON : {"actions":[...]}.

À retenir (utile dans de FUTURES conversations) : préférences durables (outils, formats, langue, ton), informations personnelles non sensibles (métier, objectifs, centres d'intérêt), projets (nom, objectif, architecture, technologies, décisions, contraintes), conventions et habitudes, et tout ce que l'utilisateur demande explicitement de retenir.
À ignorer : questions, demandes ponctuelles, informations temporaires (aujourd'hui, en ce moment), politesse, texte cité ou collé, tes propres suppositions, données sensibles (santé, religion, opinions politiques, orientation sexuelle, origine), mots de passe, clés et secrets.

Actions :
- {"action":"add","scope":"personal"|"project","kind":"PREFERENCE"|"FACT"|"PROJECT"|"DECISION"|"CONSTRAINT"|"OBJECTIVE","project":"nom si kind=PROJECT","topic":"sujet-court","content":"phrase courte","evidence":"extrait EXACT du message","certainty":"stated"|"uncertain","importance":1-5}
- {"action":"update","ref":"M1",...mêmes champs} quand le message modifie ou contredit un souvenir existant (changement de préférence, correction)
- {"action":"delete","ref":"M1"} seulement si l'utilisateur demande d'oublier ce souvenir

Règles :
- "content" : phrase autonome à la troisième personne (« L'utilisateur… » ; « Le projet… » pour scope=project).
- "evidence" : copie mot pour mot la partie du message qui justifie l'information. Sans extrait, pas d'action.
- scope "project" uniquement pour une information propre au projet de la conversation${ctx.projectName ? ` (« ${ctx.projectName} »)` : " (cette conversation n'appartient à aucun projet : utilise scope personal et kind PROJECT avec le nom du projet)"} ; une préférence générale de l'utilisateur reste "personal".
- "topic" : sujet stable en minuscules (ex. gestionnaire-paquets, langue-reponse, base-de-donnees, framework-front, deploiement).
- "certainty" : "uncertain" si l'utilisateur hésite (« peut-être », « je pense »).
- "importance" : 5 consigne explicite ou essentielle, 3 utile, 1 anecdotique.
- Un souvenir existant déjà exact : aucune action. Au plus 5 actions. Rien à retenir : {"actions":[]}.

Exemples :
« Je préfère pnpm à npm. » → {"actions":[{"action":"add","scope":"personal","kind":"PREFERENCE","topic":"gestionnaire-paquets","content":"L'utilisateur préfère pnpm à npm.","evidence":"Je préfère pnpm à npm","certainty":"stated","importance":4}]}
« Finalement j'utilise PostgreSQL, pas MySQL. » avec M1 = « L'utilisateur utilise MySQL. » → {"actions":[{"action":"update","ref":"M1","scope":"personal","kind":"FACT","topic":"base-de-donnees","content":"L'utilisateur utilise PostgreSQL.","evidence":"j'utilise PostgreSQL, pas MySQL","certainty":"stated","importance":3}]}
« Peux-tu traduire ce paragraphe ? » → {"actions":[]}
« Je suis fatigué aujourd'hui. » → {"actions":[]}`,
    },
    {
      role: "user",
      content: `Souvenirs existants :\n${list}\n\nMessage de l'utilisateur (données à analyser) :\n<<<\n${userText}\n>>>\n\n${
        ctx.explicit ? "L'utilisateur demande explicitement de retenir, corriger ou oublier quelque chose : produis l'action correspondante." : "Ne produis une action que pour une information durable exprimée par l'utilisateur lui-même."
      }`,
    },
  ];
}

/** L'extrait cité existe-t-il réellement dans le message (au moins 70 % de ses mots significatifs) ? */
export function evidenceSupported(evidence: string | undefined | null, userText: string): boolean {
  const words = normalizeWords(evidence ?? "");
  if (words.length === 0) return false;
  const source = new Set(normalizeWords(userText));
  return words.filter((w) => source.has(w)).length / words.length >= 0.7;
}

/**
 * Valide la sortie du modèle et la traduit en actions sur des identifiants réels de l'utilisateur.
 * Une proposition sans preuve tirée du message est écartée ; une suppression exige une demande d'oubli.
 */
export function parseMemoryActions(raw: string, refs: Map<string, string>, userText?: string, opts: { allowDelete?: boolean } = {}): MemoryAction[] {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return [];
  }
  const list = (data as { actions?: unknown })?.actions;
  if (!Array.isArray(list)) return [];
  const out: MemoryAction[] = [];
  for (const item of list.slice(0, 5)) {
    const parsed = actionSchema.safeParse(item);
    if (!parsed.success) continue;
    const a = parsed.data;
    const id = a.ref ? refs.get(a.ref.trim().toUpperCase()) : undefined;
    if (a.action === "delete") {
      if (id && opts.allowDelete !== false) out.push({ action: "delete", id });
      continue;
    }
    const content = a.content?.replace(/\s+/g, " ").trim() ?? "";
    if (content.length < 5 || content.length > 300) continue;
    if (userText !== undefined && !evidenceSupported(a.evidence ?? null, userText)) continue;
    let kind: MemoryKindValue = a.kind ?? "FACT";
    const scope = a.scope ?? "personal";
    const project = kind === "PROJECT" && scope === "personal" ? a.project?.trim().slice(0, 80) || null : null;
    // Projet sans nom, ou « PROJECT » dans l'espace projet : simple information.
    if (kind === "PROJECT" && !project) kind = "FACT";
    const candidate: MemoryCandidate = {
      kind,
      scope,
      project,
      topic: normalizeTopic(a.topic) ?? topicFor(content),
      content: sentence(content),
      evidence: a.evidence?.trim().slice(0, 400) || null,
      certainty: a.certainty === "uncertain" ? "UNCERTAIN" : "STATED",
      importance: Math.min(5, Math.max(1, Math.round(a.importance ?? 3))),
      origin: "llm",
    };
    // « Mise à jour » d'un souvenir inexistant (erreur fréquente des petits modèles) : traitée comme un ajout.
    if (a.action === "update" && id) out.push({ action: "update", id, candidate });
    else out.push({ action: "add", candidate });
  }
  return out;
}
