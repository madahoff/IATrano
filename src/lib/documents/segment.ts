import { createHash } from "node:crypto";
import { countTextTokens } from "@/lib/llm/tokens";
import type { Block, ExtractedUnit, SectionDraft, SegmentDraft, SegmentKind } from "./types";

// Structure et segmentation : texte canonique des unités → blocs (titres, paragraphes, tableaux, légendes)
// → sections hiérarchiques → segments de taille adaptée au modèle, sans couper un tableau de ses en-têtes
// ni séparer une légende de ce qu'elle décrit. Fonctions pures (testées sans base ni modèle).

export const hashText = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32);

const NUMBERED_HEADING = /^((?:\d{1,2}\.){0,4}\d{1,2})\.?\s+(\S.{1,110})$/;
const NAMED_HEADING = /^(chapitre|chapter|partie|part|section|annexe|appendix|titre|livre|module|leçon|lesson)\s+([0-9]{1,3}|[IVXLC]{1,7}|[A-Z])\b[\s.:–-]*(.{0,110})$/i;
const CAPTION = /^(?:>\s*)?(?:l[ée]gende\s*:\s*|(?:figure|fig\.|tableau|table|illustration|graphique|sch[ée]ma|image|photo|diagramme)\s*\d+[a-z]?\s*[.:–-])/i;
const SENTENCE_END = /[.!?:;»")\]]$/;

/** Lignes répétées en haut ou en bas de nombreuses pages (titres courants, numéros) : exclues des segments. */
export function detectBoilerplate(units: Array<Pick<ExtractedUnit, "text">>): Set<string> {
  if (units.length < 6) return new Set();
  const counts = new Map<string, number>();
  for (const u of units) {
    const lines = u.text.split("\n").map((l) => l.trim()).filter(Boolean);
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(boilerKey));
    for (const k of edge) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const min = Math.max(4, Math.ceil(units.length * 0.3));
  return new Set([...counts].filter(([k, n]) => n >= min && k.length < 120).map(([k]) => k));
}
const boilerKey = (line: string) => line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

function headingOf(line: string, plain: boolean): { level: number; text: string } | null {
  const md = /^(#{1,6})\s+(.+)$/.exec(line);
  if (md) return { level: md[1].length, text: md[2].trim() };
  if (!plain || line.length > 120 || line.length < 3) return null;
  const named = NAMED_HEADING.exec(line);
  if (named) return { level: /^(partie|part|livre|titre)/i.test(named[1]) ? 1 : /^(section)/i.test(named[1]) ? 2 : 1, text: line };
  const num = NUMBERED_HEADING.exec(line);
  if (num && !SENTENCE_END.test(line) && /^[A-ZÀ-ÖØ-Þ«"']/.test(num[2]) && num[2].split(/\s+/).length <= 14 && !/^\d{1,3}\s+\d/.test(line)) {
    const depth = num[1].split(".").length;
    // « 2018 Rapport » ou « 12 mois » ne sont pas des titres : numéro de section plausible uniquement.
    if (Number(num[1].split(".")[0]) > 60) return null;
    return { level: Math.min(6, depth), text: line };
  }
  const letters = line.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase() && line.split(/\s+/).length <= 10 && !SENTENCE_END.test(line)) return { level: 2, text: line };
  return null;
}

function isTableRow(line: string) {
  return /^\|.*\|\s*$/.test(line);
}

/**
 * Découpe le texte canonique des unités en blocs. `plain` : texte brut (PDF, TXT, OCR) où les titres sont
 * déduits par heuristique ; sinon seuls les titres Markdown (#) comptent.
 */
export function parseBlocks(units: ExtractedUnit[], opts: { plain: boolean | ((unit: ExtractedUnit) => boolean); boilerplate?: Set<string> }): Block[] {
  const blocks: Block[] = [];
  const boiler = opts.boilerplate ?? new Set<string>();
  for (const unit of units) {
    if (unit.status === "FAILED" || unit.status === "SKIPPED" || !unit.text.trim()) continue;
    const source: SegmentKind = unit.method === "OCR" ? "OCR" : unit.method === "TRANSCRIPT" ? "TRANSCRIPT" : unit.method === "KEYFRAME" ? "VISUAL" : "TEXT";
    const plain = typeof opts.plain === "function" ? opts.plain(unit) : opts.plain;
    const time = { startMs: unit.startMs ?? null, endMs: unit.endMs ?? null };
    const lines = unit.text.replace(/\r/g, "").split("\n");
    let para: string[] = [];
    const flush = () => {
      const text = para.join(" ").replace(/\s+/g, " ").trim();
      para = [];
      if (!text) return;
      const prev = blocks.at(-1);
      // Paragraphe coupé par un saut de page : recollé au précédent s'il ne se terminait pas.
      if (prev && prev.type === "paragraph" && prev.unit !== unit.number && prev.source === source && !SENTENCE_END.test(prev.text) && /^[a-zà-ÿ(,]/.test(text)) {
        prev.text = joinHyphen(prev.text, text);
        return;
      }
      // Transcription : chaque phrase porte son horodatage « [hh:mm:ss] ».
      const stamp = source === "TRANSCRIPT" ? /^\[(\d{2}):(\d{2}):(\d{2})\]/.exec(text) : null;
      const startMs = stamp ? (Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3])) * 1000 : time.startMs;
      blocks.push({ type: "paragraph", text, unit: unit.number, source, startMs, endMs: stamp ? startMs : time.endMs });
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        flush();
        continue;
      }
      if (plain && boiler.has(boilerKey(line))) continue;
      if (plain && /^(?:page\s*)?\d{1,4}(?:\s*(?:\/|sur|of)\s*\d{1,4})?$/i.test(line)) continue;
      if (isTableRow(line)) {
        flush();
        const rows: string[] = [];
        while (i < lines.length && isTableRow(lines[i].trim())) rows.push(lines[i++].trim());
        i--;
        const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
        const hasSeparator = rows.length > 1 && /^\|[\s:|-]+\|$/.test(rows[1]);
        const prev = blocks.at(-1);
        const caption = prev && prev.type === "caption" && prev.unit === unit.number ? (blocks.pop() as { text: string }).text : null;
        blocks.push({ type: "table", header: hasSeparator ? body[0] : null, rows: hasSeparator ? body.slice(1) : body, caption, unit: unit.number, source: source === "TEXT" ? "TABLE" : source });
        continue;
      }
      const heading = headingOf(line, plain);
      if (heading && (para.length === 0 || !plain)) {
        flush();
        blocks.push({ type: "heading", level: heading.level, text: heading.text.slice(0, 200), unit: unit.number, ...time });
        continue;
      }
      if (CAPTION.test(line)) {
        flush();
        blocks.push({ type: "caption", text: line.replace(/^>\s*/, ""), unit: unit.number, source: "CAPTION", ...time });
        continue;
      }
      if (/^>\s*notes?\s*:/i.test(line)) {
        flush();
        blocks.push({ type: "note", text: line.replace(/^>\s*/, ""), unit: unit.number, source: "NOTE", ...time });
        continue;
      }
      if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) {
        // Élément de liste : gardé sur sa ligne (les étapes d'une procédure restent lisibles).
        flush();
        para.push(line);
        flush();
        continue;
      }
      if (para.length && para[para.length - 1].endsWith("-") && /^[a-zà-ÿ]/.test(line)) {
        para[para.length - 1] = para[para.length - 1].slice(0, -1) + line;
        continue;
      }
      para.push(line);
    }
    flush();
  }
  return blocks;
}

function joinHyphen(a: string, b: string) {
  return a.endsWith("-") && /^[a-zà-ÿ]/.test(b) ? a.slice(0, -1) + b : `${a} ${b}`;
}

function blockText(b: Block): string {
  if (b.type === "heading") return b.text;
  if (b.type === "table") return [b.caption, b.header, ...(b.header ? ["|---|"] : []), ...b.rows].filter(Boolean).join("\n");
  return b.text;
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+(?:[.!?]+["»)]*\s*|$)/g) ?? [text];
  return parts.map((s) => s.trim()).filter(Boolean);
}

export type SegmentOptions = { targetTokens: number; overlapTokens: number };

/**
 * Sections (titres hiérarchiques) et segments. Un segment ne franchit jamais une frontière de section ;
 * un tableau trop long est découpé par groupes de lignes en répétant l'en-tête ; une légende reste avec
 * le bloc qui la suit ; le chevauchement reprend la fin du segment précédent de la même section.
 */
export function buildStructure(blocks: Block[], title: string, opts: SegmentOptions): { sections: SectionDraft[]; segments: SegmentDraft[] } {
  const target = Math.max(120, opts.targetTokens);
  const max = Math.round(target * 1.5);
  const overlap = Math.max(0, Math.min(opts.overlapTokens, Math.round(target / 3)));
  const sections: Array<SectionDraft & { blocks: Block[] }> = [];
  const stack: Array<{ level: number; title: string }> = [];
  const open = (level: number, heading: string, b: Block | null) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: heading });
    sections.push({
      ordinal: sections.length,
      level,
      title: heading,
      path: stack.map((s) => s.title),
      pageStart: b?.unit ?? null,
      pageEnd: b?.unit ?? null,
      startMs: b && "startMs" in b ? (b.startMs ?? null) : null,
      endMs: null,
      tokenCount: 0,
      contentHash: "",
      text: "",
      blocks: [],
    });
  };
  for (const b of blocks) {
    if (b.type === "heading") {
      open(b.level, b.text, b);
      continue;
    }
    if (!sections.length) open(1, title, b);
    const s = sections[sections.length - 1];
    s.blocks.push(b);
    s.pageStart ??= b.unit;
    s.pageEnd = Math.max(s.pageEnd ?? b.unit, b.unit);
    if ("startMs" in b && b.startMs != null) s.startMs ??= b.startMs;
    if ("endMs" in b && b.endMs != null) s.endMs = b.endMs;
  }

  const segments: SegmentDraft[] = [];
  for (const s of sections) {
    const parts: string[] = [];
    let current: { texts: string[]; tokens: number; first: number | null; last: number | null; type: SegmentKind; startMs: number | null; endMs: number | null } | null = null;
    let carry = "";
    const emit = () => {
      if (!current || !current.texts.length) return;
      const content = current.texts.join("\n\n").trim();
      if (content) {
        segments.push({
          ordinal: segments.length,
          content,
          tokenCount: countTextTokens(content),
          page: current.first,
          pageEnd: current.last,
          sectionOrdinal: s.ordinal,
          sectionPath: s.path,
          type: current.type,
          startMs: current.startMs,
          endMs: current.endMs,
          contentHash: hashText(`${s.path.join(">")}\n${content}`),
        });
        carry = overlap ? tail(content, overlap) : "";
      }
      current = null;
    };
    const start = (b: Block, type: SegmentKind) => {
      current = { texts: carry ? [`(…) ${carry}`] : [], tokens: carry ? countTextTokens(carry) : 0, first: b.unit, last: b.unit, type, startMs: "startMs" in b ? (b.startMs ?? null) : null, endMs: "endMs" in b ? (b.endMs ?? null) : null };
    };
    const append = (b: Block, text: string, tokens: number, type: SegmentKind) => {
      if (!current) start(b, type);
      const c = current!;
      c.texts.push(text);
      c.tokens += tokens;
      c.last = Math.max(c.last ?? b.unit, b.unit);
      if (type !== "TEXT" && c.type === "TEXT" && c.texts.length <= 2) c.type = type;
      if ("endMs" in b && b.endMs != null) c.endMs = b.endMs;
    };
    for (let i = 0; i < s.blocks.length; i++) {
      const b = s.blocks[i];
      const text = blockText(b);
      parts.push(text);
      const tokens = countTextTokens(text);
      if (b.type === "table") {
        const rowsTokens = tokens;
        if (rowsTokens <= max) {
          if (current && (current as { tokens: number }).tokens + rowsTokens > max) emit();
          append(b, text, rowsTokens, b.source);
          continue;
        }
        emit();
        carry = "";
        const head = [b.caption, b.header, ...(b.header ? ["|---|"] : [])].filter(Boolean).join("\n");
        const headTokens = countTextTokens(head);
        let group: string[] = [];
        let groupTokens = headTokens;
        for (const row of b.rows) {
          const t = countTextTokens(row) + 1;
          if (group.length && groupTokens + t > target) {
            append(b, [head, ...group].filter(Boolean).join("\n"), groupTokens, b.source);
            emit();
            carry = "";
            group = [];
            groupTokens = headTokens;
          }
          group.push(row);
          groupTokens += t;
        }
        if (group.length) append(b, [head, ...group].filter(Boolean).join("\n"), groupTokens, b.source);
        emit();
        carry = "";
        continue;
      }
      if (b.type === "caption") {
        // Une légende ne termine jamais un segment : elle est rattachée à ce qui suit (figure, tableau, explication).
        const next = s.blocks[i + 1];
        const nextTokens = next ? countTextTokens(blockText(next)) : 0;
        if (current && (current as { tokens: number }).tokens + tokens + Math.min(nextTokens, target / 2) > max) emit();
        append(b, text, tokens, "CAPTION");
        continue;
      }
      if (tokens > max) {
        // Paragraphe très long : découpé aux fins de phrases.
        for (const sentence of splitSentences(text)) {
          const st = countTextTokens(sentence);
          if (current && (current as { tokens: number }).tokens + st > target) emit();
          append(b, sentence, st, sourceOf(b));
        }
        continue;
      }
      if (current && (current as { tokens: number }).tokens + tokens > target) {
        // On ne coupe pas avant une conclusion courte (« Ainsi… », « En conclusion… ») si la marge le permet.
        const conclusive = /^(ainsi|donc|en conclusion|en résumé|par conséquent|finalement|therefore|in conclusion|thus)\b/i.test(text);
        if (!(conclusive && (current as { tokens: number }).tokens + tokens <= max)) emit();
      }
      append(b, text, tokens, sourceOf(b));
    }
    emit();
    const pageMarkedText = s.blocks.map((b) => `[p. ${b.unit}] ${blockText(b)}`).join("\n");
    s.text = pageMarkedText;
    s.tokenCount = countTextTokens(parts.join("\n"));
    s.contentHash = hashText(`${s.path.join(">")}\n${parts.join("\n")}`);
  }
  return { sections: sections.map(({ blocks: _b, ...rest }) => rest), segments };
}

const sourceOf = (b: Block): SegmentKind => (b.type === "heading" ? "TEXT" : b.source);

function tail(text: string, tokens: number): string {
  const sentences = splitSentences(text.replace(/^\(…\)\s*/, ""));
  const out: string[] = [];
  let n = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const t = countTextTokens(sentences[i]);
    if (n + t > tokens) break;
    out.unshift(sentences[i]);
    n += t;
  }
  return out.join(" ");
}

/** Taille de segment recommandée selon la fenêtre effective du modèle (bornée par les réglages). */
export function recommendedSegmentTokens(capacity: number, configured: number) {
  // ~10 passages doivent tenir dans ~40 % du contexte, avec une marge pour les en-têtes.
  const byWindow = Math.floor((capacity * 0.4) / 10);
  return Math.max(160, Math.min(configured, byWindow));
}

/** Langue dominante (configuration de recherche plein texte PostgreSQL). */
export function detectLanguage(text: string): "french" | "english" | "simple" {
  const sample = ` ${text.slice(0, 200_000).toLowerCase().replace(/[^a-zà-ÿ'\s]/g, " ")} `;
  const count = (words: string[]) => words.reduce((n, w) => n + (sample.split(` ${w} `).length - 1), 0);
  const fr = count(["le", "la", "les", "des", "est", "une", "et", "dans", "pour", "que", "qui", "du", "sur", "avec"]);
  const en = count(["the", "and", "of", "to", "is", "in", "that", "for", "with", "are", "this", "on", "be", "as"]);
  if (fr + en < 8) return "simple";
  return fr >= en ? "french" : "english";
}
