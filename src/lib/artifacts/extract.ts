// Extraction des artifacts produits par Qwen : <artifact title="…">…page HTML…</artifact>.
// Fonctions pures (aucune E/S), utilisables pendant le streaming : le bloc n'apparaît jamais dans le texte
// de la réponse ; son code est transmis à part, au fil de l'eau.

export const ARTIFACT_OPEN = "<artifact";
export const ARTIFACT_CLOSE = "</artifact>";
export const DEFAULT_ARTIFACT_TITLE = "Page interactive";
export const MAX_ARTIFACT_CHARS = 300_000;

export type ExtractEvent =
  | { type: "text"; text: string }
  | { type: "start"; title: string }
  | { type: "code"; delta: string }
  | { type: "end"; title: string; code: string }
  /** Flux terminé au milieu d'un bloc : page incomplète. */
  | { type: "incomplete"; title: string; code: string };

/** Longueur du plus long suffixe de `s` qui est un début de `token` (à retenir en attendant la suite). */
function partialSuffix(s: string, token: string): number {
  for (let n = Math.min(token.length - 1, s.length); n > 0; n--) {
    if (token.startsWith(s.slice(-n).toLowerCase())) return n;
  }
  return 0;
}

const ENTITIES: Record<string, string> = { "&quot;": '"', "&#39;": "'", "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" };

export function parseTitle(attrs: string): string {
  const m = attrs.match(/title\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").replace(/&(quot|#39|apos|amp|lt|gt);/g, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();
  return (raw || DEFAULT_ARTIFACT_TITLE).slice(0, 120);
}

/** Retire les clôtures Markdown que le modèle ajoute parfois autour du code (```html … ```). */
export function cleanCode(code: string): string {
  return code
    .replace(/^\s*```[a-z]*\s*\n?/i, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
}

/** Nettoie le texte visible : blocs de code vides laissés autour d'un artifact. */
export function cleanVisibleText(text: string): string {
  return text.replace(/```[a-z]*\s*```/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function createArtifactExtractor() {
  let state: "text" | "attrs" | "code" = "text";
  let buf = "";
  let title = DEFAULT_ARTIFACT_TITLE;
  let code = "";

  function run(final: boolean): ExtractEvent[] {
    const out: ExtractEvent[] = [];
    for (;;) {
      if (state === "text") {
        const i = buf.toLowerCase().indexOf(ARTIFACT_OPEN);
        if (i < 0) {
          const keep = final ? 0 : partialSuffix(buf, ARTIFACT_OPEN);
          if (buf.length > keep) out.push({ type: "text", text: buf.slice(0, buf.length - keep) });
          buf = buf.slice(buf.length - keep);
          return out;
        }
        // « <artifact » doit être suivi d'un espace ou de « > » : sinon ce n'est pas notre balise (ex. <artifacts>).
        const next = buf[i + ARTIFACT_OPEN.length];
        if (next === undefined && !final) {
          if (i > 0) out.push({ type: "text", text: buf.slice(0, i) });
          buf = buf.slice(i);
          return out;
        }
        if (next !== undefined && !/[\s>]/.test(next)) {
          out.push({ type: "text", text: buf.slice(0, i + 1) });
          buf = buf.slice(i + 1);
          continue;
        }
        if (i > 0) out.push({ type: "text", text: buf.slice(0, i) });
        buf = buf.slice(i + ARTIFACT_OPEN.length);
        state = "attrs";
      } else if (state === "attrs") {
        const j = buf.indexOf(">");
        if (j < 0) {
          // Attributs anormalement longs : ce n'était pas une balise.
          if (buf.length > 500 || final) {
            out.push({ type: "text", text: ARTIFACT_OPEN + buf });
            buf = "";
            state = "text";
          }
          return out;
        }
        title = parseTitle(buf.slice(0, j));
        code = "";
        buf = buf.slice(j + 1);
        state = "code";
        out.push({ type: "start", title });
      } else {
        const k = buf.toLowerCase().indexOf(ARTIFACT_CLOSE);
        if (k < 0) {
          if (final) {
            code += buf;
            buf = "";
            out.push({ type: "incomplete", title, code: cleanCode(code) });
            state = "text";
            return out;
          }
          const keep = partialSuffix(buf, ARTIFACT_CLOSE);
          const delta = buf.slice(0, buf.length - keep);
          if (delta) {
            code += delta;
            out.push({ type: "code", delta });
          }
          buf = buf.slice(buf.length - keep);
          return out;
        }
        const delta = buf.slice(0, k);
        if (delta) {
          code += delta;
          out.push({ type: "code", delta });
        }
        out.push({ type: "end", title, code: cleanCode(code) });
        buf = buf.slice(k + ARTIFACT_CLOSE.length);
        state = "text";
      }
    }
  }

  return {
    push: (delta: string) => {
      buf += delta;
      return run(false);
    },
    finish: () => run(true),
    get inArtifact() {
      return state !== "text";
    },
  };
}

/** Extraction en une fois (texte complet). */
export function extractArtifacts(text: string): { text: string; artifacts: Array<{ title: string; code: string; complete: boolean }> } {
  const ex = createArtifactExtractor();
  const events = [...ex.push(text), ...ex.finish()];
  let visible = "";
  const artifacts: Array<{ title: string; code: string; complete: boolean }> = [];
  for (const e of events) {
    if (e.type === "text") visible += e.text;
    else if (e.type === "end") artifacts.push({ title: e.title, code: e.code, complete: true });
    else if (e.type === "incomplete") artifacts.push({ title: e.title, code: e.code, complete: false });
  }
  return { text: cleanVisibleText(visible), artifacts };
}

// ---------------------------------------------------------------- Validation

export type ArtifactCheck = { valid: boolean; issues: string[] };

const EXTERNAL = [
  /\b(?:src|href|action|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i,
  /@import\b/i,
  /url\(\s*["']?\s*(?:https?:)?\/\//i,
  /\bimport\s*\(?\s*["'](?:https?:)?\/\//i,
];
const NETWORK = /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource|sendBeacon/;
const STORAGE = /\blocalStorage\b|\bsessionStorage\b|document\.cookie|indexedDB/;

/** Vérifie qu'un code d'artifact est exploitable et signale ce qui sera bloqué par le bac à sable. */
export function validateArtifact(code: string, complete = true): ArtifactCheck {
  const issues: string[] = [];
  let valid = true;
  if (!complete) {
    valid = false;
    issues.push("Page incomplète : la génération s'est arrêtée avant la fin du code.");
  }
  if (!code.trim()) {
    return { valid: false, issues: [...issues, "Page vide."] };
  }
  if (code.length > MAX_ARTIFACT_CHARS) {
    valid = false;
    issues.push(`Page trop volumineuse (${Math.round(code.length / 1000)} k caractères, maximum ${MAX_ARTIFACT_CHARS / 1000} k).`);
  }
  if (!/<(?:!doctype|html|head|body|div|main|section|svg|canvas|script|style|p|h[1-6]|button|input|table|ul|form)\b/i.test(code)) {
    valid = false;
    issues.push("Le code ne contient pas de HTML exploitable.");
  }
  if (EXTERNAL.some((r) => r.test(code))) issues.push("Ressources externes détectées (scripts, styles, images ou polices en ligne) : elles sont bloquées dans l'aperçu.");
  if (NETWORK.test(code)) issues.push("Requêtes réseau détectées : elles sont bloquées dans l'aperçu.");
  if (STORAGE.test(code)) issues.push("Stockage du navigateur utilisé : il est remplacé par une mémoire temporaire dans l'aperçu.");
  return { valid, issues };
}
