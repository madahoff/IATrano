import { z } from "zod";
import { countTextTokens } from "@/lib/llm/tokens";
import type { ChatMessage } from "@/lib/llm/types";
import { similarity } from "@/lib/memory/select";
import type { SummaryReference, SummarySections } from "./types";

// Résumé de compaction : sections simples (adaptées à un petit modèle comme Qwen 3B), produites en JSON
// contraint par schéma, validées côté serveur. Les éléments techniques précis (sources Web, URL, fichiers,
// blocs de code) ne sont PAS confiés au modèle : ils sont extraits tels quels des messages d'origine.

export const SUMMARY_JSON_SCHEMA = {
  type: "object",
  properties: {
    objective: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    facts: { type: "array", items: { type: "string" } },
    state: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
  required: ["objective", "constraints", "decisions", "facts", "state", "nextSteps"],
} as const;

const LIST_KEYS = ["constraints", "decisions", "facts", "state", "nextSteps"] as const;
type ListKey = (typeof LIST_KEYS)[number];
export type LlmSections = Omit<SummarySections, "references">;

const MAX_ITEMS = 10;
const MAX_ITEM_CHARS = 400;

const rawSchema = z.object({
  objective: z.string(),
  constraints: z.array(z.unknown()).default([]),
  decisions: z.array(z.unknown()).default([]),
  facts: z.array(z.unknown()).default([]),
  state: z.array(z.unknown()).default([]),
  nextSteps: z.array(z.unknown()).default([]),
});

export const EMPTY_SECTIONS: LlmSections = { objective: "", constraints: [], decisions: [], facts: [], state: [], nextSteps: [] };

export type TranscriptMessage = { id: string; role: "USER" | "ASSISTANT"; content: string; createdAt: Date };

// --- Transcription envoyée au modèle --------------------------------------------------------------

const CODE_BLOCK = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;

/** Remplace les longs blocs de code par une référence (ils restent dans l'historique et dans les références). */
export function compactCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK, (full, lang: string, body: string) => {
    const lines = body.split("\n").filter((l) => l.trim()).length;
    if (lines <= 12 && body.length <= 600) return full;
    return `[bloc de code ${lang || "texte"} de ${lines} lignes, conservé dans l'historique ; première ligne : ${body.split("\n").find((l) => l.trim())?.trim().slice(0, 100) ?? ""}]`;
  });
}

function truncateMiddle(text: string, maxTokens: number): string {
  if (countTextTokens(text) <= maxTokens) return text;
  const keep = Math.max(200, Math.floor(maxTokens * 3.2));
  return `${text.slice(0, Math.floor(keep * 0.6))}\n[…passage central omis…]\n${text.slice(-Math.floor(keep * 0.4))}`;
}

export function transcriptLines(messages: TranscriptMessage[], perMessageMax: number): string[] {
  return messages.map((m) => {
    const who = m.role === "USER" ? "Utilisateur" : "Assistant";
    return `${who} : ${truncateMiddle(compactCodeBlocks(m.content.trim()), perMessageMax)}`;
  });
}

/** Découpe la transcription en morceaux tenant dans le budget d'un appel au modèle. */
export function chunkTranscript(lines: string[], chunkTokens: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const line of lines) {
    const t = countTextTokens(line) + 2;
    if (cur.length && size + t > chunkTokens) {
      chunks.push(cur.join("\n\n"));
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += t;
  }
  if (cur.length) chunks.push(cur.join("\n\n"));
  return chunks;
}

export function buildSummaryPrompt(previous: LlmSections | null, transcript: string, strict = false, firstRequest?: string): ChatMessage[] {
  const prev = previous && previous.objective ? JSON.stringify(previous) : "(aucun)";
  const anchor = firstRequest ? `Première demande de l'utilisateur (elle fixe l'objectif principal) :\n${firstRequest.slice(0, 600)}\n\n` : "";
  return [
    {
      role: "system",
      content: `Tu résumes une conversation pour qu'un assistant puisse la poursuivre sans relire les anciens messages. Réponds uniquement en JSON.
Règles :
- Écris dans la langue de la conversation, en phrases courtes et factuelles.
- Garde les noms exacts : fichiers, commandes, versions, nombres, URL, noms propres.
- N'invente rien. N'inclus jamais de mot de passe, de clé ni de secret.
- Fusionne avec le résumé précédent : garde ce qui est toujours valable, mets à jour ce qui a changé.
- L'objectif principal est celui fixé au début de la conversation, sauf si l'utilisateur en a explicitement changé.${strict ? "\n- Chaque liste contient au plus 6 éléments. L'objectif est une seule phrase." : ""}`,
    },
    {
      role: "user",
      content: `${anchor}Résumé précédent (JSON) :\n${prev}\n\nÉchanges à intégrer :\n${transcript}\n\nProduis le JSON :
- objective : l'objectif principal de la discussion (une phrase) ;
- constraints : contraintes et préférences exprimées par l'utilisateur ;
- decisions : décisions prises ;
- facts : informations techniques et faits établis ;
- state : ce qui a été fait et où on en est ;
- nextSteps : questions non résolues et prochaines étapes.`,
    },
  ];
}

// --- Validation -------------------------------------------------------------------------------------

function cleanItem(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").replace(/^[-*•\d.)\s]+/, "").trim();
  if (s.length < 3) return null;
  return s.length > MAX_ITEM_CHARS ? `${s.slice(0, MAX_ITEM_CHARS - 1)}…` : s;
}

const LEAK = /(produis le json|réponds uniquement en json|résumé précédent|échanges à intégrer|"objective"\s*:)/i;

export type SummaryValidation = { ok: true; sections: LlmSections } | { ok: false; reason: string };

/** Vérifie qu'un résumé n'est ni vide, ni incohérent, ni manifestement incomplet. */
export function validateSummary(raw: string, opts: { sourceTokens: number; previous: LlmSections | null; firstRequest?: string }): SummaryValidation {
  let json: unknown;
  try {
    json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ok: false, reason: "Le modèle n'a pas renvoyé de JSON valide." };
  }
  const parsed = rawSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "Le résumé ne respecte pas la structure attendue." };
  const objective = cleanItem(parsed.data.objective) ?? "";
  const sections: LlmSections = { ...EMPTY_SECTIONS, objective };
  for (const k of LIST_KEYS) {
    const seen: string[] = [];
    for (const item of parsed.data[k]) {
      const s = cleanItem(item);
      if (s && !seen.some((x) => similarity(x, s) > 0.85)) seen.push(s);
    }
    sections[k] = seen.slice(0, MAX_ITEMS);
  }
  // Les petits modèles répètent souvent la même information dans plusieurs sections : on la garde une fois.
  const seenAll: string[] = [];
  for (const k of LIST_KEYS) {
    sections[k] = sections[k].filter((s) => {
      if (seenAll.some((x) => similarity(x, s) > 0.6)) return false;
      seenAll.push(s);
      return true;
    });
  }
  const items = LIST_KEYS.reduce((n, k) => n + sections[k].length, 0);
  if (objective.length < 8) return { ok: false, reason: "Le résumé ne précise pas l'objectif de la conversation." };
  if (items === 0) return { ok: false, reason: "Le résumé est vide." };
  const all = [objective, ...LIST_KEYS.flatMap((k) => sections[k])];
  if (all.some((s) => LEAK.test(s))) return { ok: false, reason: "Le résumé recopie les consignes au lieu de résumer." };
  const tokens = countTextTokens(all.join("\n"));
  if (opts.sourceTokens > 300 && tokens > opts.sourceTokens * 0.9) return { ok: false, reason: "Le résumé n'est pas plus court que les échanges d'origine." };
  if (opts.sourceTokens > 400 && tokens < 15) return { ok: false, reason: "Le résumé est manifestement incomplet." };

  // Garde-fou contre la perte d'informations anciennes : un petit modèle « oublie » parfois des éléments
  // du résumé précédent. Les contraintes, décisions et faits disparus sont réintégrés.
  if (opts.previous) {
    for (const k of ["constraints", "decisions", "facts"] as ListKey[]) {
      const lost = opts.previous[k].filter((old) => !sections[k].some((s) => similarity(s, old) > 0.5));
      sections[k] = [...lost, ...sections[k]].slice(-MAX_ITEMS - 2);
    }
    // L'objectif principal vient du début de la conversation : un petit modèle a tendance à le remplacer par
    // le dernier sujet abordé. Ce dernier est alors conservé comme point d'avancement.
    if (opts.previous.objective && similarity(sections.objective, opts.previous.objective) < 0.3) {
      sections.state = [`Sujet récent : ${sections.objective}`, ...sections.state.filter((s) => !s.startsWith("Sujet récent :"))].slice(0, MAX_ITEMS);
      sections.objective = opts.previous.objective;
    }
  }
  // Ancrage : un objectif sans rapport avec la première demande de l'utilisateur est remplacé par celle-ci.
  if (opts.firstRequest && similarity(sections.objective, opts.firstRequest) < 0.1) {
    const first = opts.firstRequest.replace(/\s+/g, " ").trim();
    sections.objective = `Demande initiale : ${first.length > 240 ? `${first.slice(0, 239)}…` : first}`;
  }
  return { ok: true, sections };
}

// --- Demandes de l'utilisateur (déterministes) ----------------------------------------------------

const REQUEST_MAX_CHARS = 280;
const REQUESTS_MAX_TOKENS = 700;

/**
 * Les messages de l'utilisateur portent ses contraintes, choix et demandes ; un petit modèle les écrase souvent
 * sous le contenu des réponses. Ils sont donc conservés cités (condensés), sans passer par le modèle.
 */
export function userRequests(messages: TranscriptMessage[]): string[] {
  return messages
    .filter((m) => m.role === "USER")
    .map((m) => compactCodeBlocks(m.content).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.length > REQUEST_MAX_CHARS ? `${t.slice(0, REQUEST_MAX_CHARS - 1)}…` : t));
}

/** Fusionne en respectant le budget : la première demande et les plus récentes sont prioritaires. */
export function mergeRequests(previous: string[], next: string[]): string[] {
  const all = [...previous, ...next];
  const cost = (l: string[]) => countTextTokens(l.join("\n"));
  if (cost(all) <= REQUESTS_MAX_TOKENS) return all;
  const out = [...all];
  while (out.length > 2 && cost(out) > REQUESTS_MAX_TOKENS) out.splice(1, 1);
  return out;
}

// --- Références techniques (déterministes) ----------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;
const FILE_RE = /(?:^|[\s(`'"])((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8}|[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|java|kt|php|rb|json|ya?ml|toml|md|sql|prisma|sh|css|scss|html|env|conf|ini|dockerfile))(?=$|[\s)`'",:;])/gim;

export type SourceRef = { title: string; url: string };

const PLACEHOLDER_PATH = /(^|\/)(path\/to|your[\w-]*|votre[\w-]*|exemple|example)(\/|\.|$)/i;
const PLACEHOLDER_URL = /^https?:\/\/(?:[\w-]+\.)*(?:example\.(?:com|org|net)|exemple\.\w+|your[\w-]*\.\w+|votre[\w-]*\.\w+|mon-?domaine\.\w+|domain\.tld)(?:[/:?#]|$)/i;

export function extractReferences(messages: TranscriptMessage[], sources: SourceRef[]): SummaryReference[] {
  const refs: SummaryReference[] = [];
  const urls = new Set<string>();
  for (const s of sources) {
    if (urls.has(s.url) || urls.size >= 12) continue;
    urls.add(s.url);
    refs.push({ type: "source", label: s.title || s.url, url: s.url });
  }
  const files = new Set<string>();
  const codes: SummaryReference[] = [];
  for (const m of messages) {
    for (const u of m.content.match(URL_RE) ?? []) {
      // Adresses d'exemple générées par le modèle (« your-api-url.com », example.com) : sans valeur de traçabilité.
      if (urls.has(u) || urls.size >= 16 || PLACEHOLDER_URL.test(u)) continue;
      urls.add(u);
      refs.push({ type: "url", label: u, url: u });
    }
    for (const match of m.content.matchAll(FILE_RE)) {
      // « Next.js » : nom de produit ; « path/to/your/cert.pem » : chemin d'exemple inventé.
      const f = match[1].replace(/^\.\//, "");
      if (/^[A-Z][a-z]+\.js$/.test(f) || PLACEHOLDER_PATH.test(f)) continue;
      // Les fichiers cités par l'utilisateur passent en premier ; ceux des réponses dans la limite restante.
      if (m.role === "USER" ? files.size < 15 : files.size < 10) files.add(f);
    }
    for (const match of m.content.matchAll(CODE_BLOCK)) {
      const lang = match[1] || null;
      const body = match[2].replace(/\s+$/, "");
      const lines = body.split("\n").filter((l) => l.trim()).length;
      const when = m.createdAt.toISOString().slice(0, 16).replace("T", " ");
      const short = lines <= 12 && body.length <= 600;
      codes.push({
        type: "code",
        lang,
        messageId: m.id,
        code: short ? body : null,
        label: short
          ? `Code ${lang ?? ""} (${m.role === "USER" ? "utilisateur" : "assistant"}, ${when} UTC)`.replace("  ", " ")
          : `Bloc ${lang ?? "de code"} de ${lines} lignes dans le message du ${when} UTC, commençant par « ${body.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? ""} »`,
      });
    }
  }
  for (const f of files) refs.push({ type: "file", label: f });
  // Les blocs les plus récents sont les plus utiles ; seuls les 3 derniers courts sont gardés en entier.
  const recent = codes.slice(-8);
  let verbatim = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i] as Extract<SummaryReference, { type: "code" }>;
    if (c.code && ++verbatim > 3) recent[i] = { ...c, code: null };
  }
  return [...refs, ...recent];
}

export function mergeReferences(previous: SummaryReference[], next: SummaryReference[]): SummaryReference[] {
  const key = (r: SummaryReference) => ("url" in r ? `u:${r.url}` : r.type === "code" ? `c:${r.messageId}:${r.label}` : `f:${r.label}`);
  const map = new Map<string, SummaryReference>();
  for (const r of [...previous, ...next]) map.set(key(r), r);
  const all = [...map.values()];
  const codes = all.filter((r) => r.type === "code").slice(-8);
  return [...all.filter((r) => r.type === "source").slice(-14), ...all.filter((r) => r.type === "url").slice(-10), ...all.filter((r) => r.type === "file").slice(-20), ...codes];
}

// --- Rendu injecté dans le prompt ---------------------------------------------------------------------

export function renderSummary(s: SummarySections): string {
  const out: string[] = [];
  if (s.objective) out.push(`Objectif : ${s.objective}`);
  if (s.requests?.length) out.push(`Demandes de l'utilisateur (citées, dans l'ordre) :\n${s.requests.map((r) => `- « ${r} »`).join("\n")}`);
  const section = (title: string, items: string[]) => {
    if (items.length) out.push(`${title} :\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  section("Contraintes et préférences", s.constraints);
  section("Décisions prises", s.decisions);
  section("Informations établies", s.facts);
  section("Avancement", s.state);
  section("Points ouverts et prochaines étapes", s.nextSteps);
  const refs: string[] = [];
  for (const r of s.references) {
    if (r.type === "source") refs.push(`- Source Web : ${r.label} — ${r.url}`);
    else if (r.type === "url") refs.push(`- Lien cité : ${r.url}`);
    else if (r.type === "file") refs.push(`- Fichier mentionné : ${r.label}`);
    else if (r.code) refs.push(`- ${r.label} :\n\`\`\`${r.lang ?? ""}\n${r.code}\n\`\`\``);
    else refs.push(`- ${r.label}`);
  }
  if (refs.length) out.push(`Références conservées :\n${refs.join("\n")}`);
  return out.join("\n\n");
}
