import { zipSync } from "fflate";
import { readZip, utf8 } from "@/lib/documents/extract/zip";

// Modification du TEXTE d'un document Word (.docx) sans le convertir : seul word/document.xml est réécrit, et
// seulement les paragraphes modifiés. Styles, numérotation, tableaux, images, en-têtes, pieds de page, sections
// et paragraphes non modifiés restent identiques octet pour octet.
//
// Limites assumées (affichées dans l'interface) : un paragraphe modifié reprend la mise en forme de son premier
// fragment de texte (un mot en gras au milieu est uniformisé) ; les paragraphes contenant des liens, champs,
// révisions suivies, commentaires, objets ou zones de texte sont en lecture seule pour ne rien casser.

export type DocxBlock = {
  index: number;
  text: string;
  editable: boolean;
  /** Raison de la lecture seule, affichée à l'utilisateur. */
  reason?: string;
  /** 0 : titre du document, 1 à 9 : niveau de titre, null : paragraphe courant. */
  heading: number | null;
  list: boolean;
  /** Position dans un tableau de premier niveau (les tableaux imbriqués sont rattachés à la cellule parente). */
  table: { table: number; row: number; cell: number } | null;
  /** Plusieurs mises en forme de caractères dans le paragraphe : elles seront uniformisées s'il est modifié. */
  mixedFormatting: boolean;
};

export class DocxEditError extends Error {}

type Tag = { start: number; end: number; name: string; closing: boolean; selfClosing: boolean; raw: string };

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function* tags(xml: string, from = 0, to = xml.length): Generator<Tag> {
  // Expression propre à chaque parcours : des parcours imbriqués ne partagent pas leur position (lastIndex).
  const re = new RegExp(TAG_RE.source, "g");
  re.lastIndex = from;
  for (let m = re.exec(xml); m && m.index < to; m = re.exec(xml)) {
    yield { start: m.index, end: m.index + m[0].length, name: m[2], closing: m[1] === "/", selfClosing: m[4] === "/", raw: m[0] };
  }
}

type Para = {
  start: number;
  /** Fin de la balise ouvrante (= fin du paragraphe pour <w:p/>). */
  openEnd: number;
  closeStart: number;
  end: number;
  openTag: string;
  nested: boolean;
  table: DocxBlock["table"];
};

function paragraphs(xml: string): Para[] {
  const out: Para[] = [];
  const open: Para[] = [];
  let tableDepth = 0;
  let tableIndex = -1;
  let row = -1;
  let cell = -1;
  for (const t of tags(xml)) {
    if (t.name === "w:tbl" && !t.selfClosing) {
      if (t.closing) tableDepth--;
      else if (++tableDepth === 1) {
        tableIndex++;
        row = -1;
      }
    } else if (t.name === "w:tr" && !t.closing && tableDepth === 1) {
      row++;
      cell = -1;
    } else if (t.name === "w:tc" && !t.closing && tableDepth === 1) cell++;
    if (t.name !== "w:p") continue;
    const table = tableDepth > 0 ? { table: tableIndex, row: Math.max(row, 0), cell: Math.max(cell, 0) } : null;
    if (t.selfClosing) {
      out.push({ start: t.start, openEnd: t.end, closeStart: t.end, end: t.end, openTag: t.raw, nested: open.length > 0, table });
    } else if (!t.closing) {
      const p: Para = { start: t.start, openEnd: t.end, closeStart: -1, end: -1, openTag: t.raw, nested: open.length > 0, table };
      open.push(p);
      out.push(p);
    } else {
      const p = open.pop();
      if (!p) throw new DocxEditError("Document Word mal formé (paragraphe non ouvert).");
      p.closeStart = t.start;
      p.end = t.end;
    }
  }
  if (open.length) throw new DocxEditError("Document Word mal formé (paragraphe non fermé).");
  return out;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

const PARA_CHILDREN = new Set(["w:pPr", "w:r", "w:proofErr", "w:bookmarkStart", "w:bookmarkEnd"]);
const RUN_CHILDREN = new Set(["w:rPr", "w:t", "w:tab", "w:br", "w:cr", "w:lastRenderedPageBreak", "w:softHyphen", "w:noBreakHyphen"]);
const READ_ONLY_REASONS: Record<string, string> = {
  "w:hyperlink": "contient un lien",
  "w:fldSimple": "contient un champ (date, numéro de page…)",
  "w:fldChar": "contient un champ (date, numéro de page…)",
  "w:instrText": "contient un champ (date, numéro de page…)",
  "w:ins": "contient des révisions suivies",
  "w:del": "contient des révisions suivies",
  "w:drawing": "contient une image ou un objet",
  "w:pict": "contient une image ou un objet",
  "w:object": "contient une image ou un objet",
  "mc:AlternateContent": "contient une image ou un objet",
  "w:commentReference": "contient un commentaire",
  "w:commentRangeStart": "contient un commentaire",
  "w:footnoteReference": "contient une note",
  "w:endnoteReference": "contient une note",
  "w:sdt": "contient un contrôle de contenu",
  "m:oMath": "contient une équation",
  "m:oMathPara": "contient une équation",
};

type Analysis = { text: string; editable: boolean; reason?: string; pPr: string; firstRPr: string; mixed: boolean; bookmarksStart: string[]; bookmarksEnd: string[] };

/** Analyse le contenu d'un paragraphe : texte affiché, éléments présents, propriétés à conserver. */
function analyze(xml: string, p: Para): Analysis {
  const res: Analysis = { text: "", editable: !p.nested, reason: p.nested ? "fait partie d'une zone de texte" : undefined, pPr: "", firstRPr: "", mixed: false, bookmarksStart: [], bookmarksEnd: [] };
  if (p.closeStart < 0 || p.openEnd === p.end) return res;
  const rPrs = new Set<string>();
  let skipUntil = -1; // fin d'un sous-arbre ignoré (pPr, rPr, paragraphe imbriqué)
  let depth = 0; // profondeur sous le paragraphe (1 = enfant direct)
  let runRPr: string | null = null;
  let runHasText = false;
  const stack: string[] = [];
  const it = tags(xml, p.openEnd, p.closeStart);
  const readOnly = (reason: string) => {
    if (res.editable) {
      res.editable = false;
      res.reason = reason;
    }
  };
  const closeOf = (open: Tag) => {
    // Fin du sous-arbre d'un élément (même nom, en tenant compte des imbrications).
    let level = 0;
    for (const t of tags(xml, open.end, p.closeStart)) {
      if (t.name !== open.name || t.selfClosing) continue;
      if (!t.closing) level++;
      else if (level-- === 0) return t;
    }
    throw new DocxEditError("Document Word mal formé.");
  };
  for (let t = it.next(); !t.done; t = it.next()) {
    const tag = t.value;
    if (tag.start < skipUntil) continue;
    if (tag.closing) {
      stack.pop();
      depth--;
      if (tag.name === "w:r") {
        if (runHasText) rPrs.add(runRPr ?? "");
        runRPr = null;
        runHasText = false;
      }
      continue;
    }
    const parent = stack.at(-1);
    const level = depth + 1;
    if (tag.name === "w:p") {
      // Paragraphe imbriqué (zone de texte) : analysé séparément, ignoré ici.
      readOnly("contient une zone de texte");
      if (!tag.selfClosing) skipUntil = closeOf(tag).end;
      continue;
    }
    if (level === 1 && !PARA_CHILDREN.has(tag.name)) readOnly(READ_ONLY_REASONS[tag.name] ?? "contient un élément non pris en charge");
    if (level === 2 && parent === "w:r" && !RUN_CHILDREN.has(tag.name)) readOnly(READ_ONLY_REASONS[tag.name] ?? "contient un élément non pris en charge");
    if (level > 2 && parent !== "w:t") readOnly(READ_ONLY_REASONS[tag.name] ?? "contient un élément non pris en charge");
    if (READ_ONLY_REASONS[tag.name]) readOnly(READ_ONLY_REASONS[tag.name]);

    if (tag.name === "w:pPr" || tag.name === "w:rPr") {
      const end = tag.selfClosing ? tag : closeOf(tag);
      const raw = xml.slice(tag.start, end.end);
      if (tag.name === "w:pPr" && level === 1) res.pPr = raw;
      if (tag.name === "w:rPr" && parent === "w:r") runRPr = raw;
      skipUntil = end.end;
      continue;
    }
    if (tag.name === "w:t") {
      if (!tag.selfClosing) {
        const end = closeOf(tag);
        const value = decode(xml.slice(tag.end, end.start));
        res.text += value;
        if (value) {
          runHasText = true;
          if (!res.firstRPr && runRPr) res.firstRPr = runRPr;
        }
        skipUntil = end.end;
      }
      continue;
    }
    if (tag.name === "w:tab") res.text += "\t";
    else if (tag.name === "w:br" || tag.name === "w:cr") {
      const type = /w:type="(\w+)"/.exec(tag.raw)?.[1];
      if (type && type !== "textWrapping") readOnly("contient un saut de page ou de colonne");
      res.text += "\n";
    } else if (tag.name === "w:noBreakHyphen") res.text += "‑";
    else if (tag.name === "w:bookmarkStart") res.bookmarksStart.push(tag.raw);
    else if (tag.name === "w:bookmarkEnd") res.bookmarksEnd.push(tag.raw);
    if (!tag.selfClosing) {
      stack.push(tag.name);
      depth++;
    }
  }
  res.mixed = rPrs.size > 1;
  return res;
}

/** Niveaux de titre et styles de liste (numérotation portée par le style), par identifiant de style. */
function paragraphStyles(stylesXml: string) {
  const headings = new Map<string, number>();
  const lists = new Set<string>();
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = /<w:name w:val="([^"]+)"/.exec(m[2])?.[1]?.toLowerCase() ?? "";
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(m[2])?.[1];
    if (name === "title") headings.set(m[1], 0);
    else if (/^heading \d$/.test(name)) headings.set(m[1], Number(name.slice(-1)));
    else if (outline !== undefined) headings.set(m[1], Number(outline) + 1);
    if (m[2].includes("<w:numPr") || /^list (bullet|number)/.test(name)) lists.add(m[1]);
  }
  return { headings, lists };
}

export function docxBlocksFromXml(documentXml: string, stylesXml = ""): DocxBlock[] {
  const styles = paragraphStyles(stylesXml);
  return paragraphs(documentXml).map((p, index) => {
    const a = analyze(documentXml, p);
    const styleId = /<w:pStyle w:val="([^"]+)"/.exec(a.pPr)?.[1];
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(a.pPr)?.[1];
    const heading = styleId && styles.headings.has(styleId) ? styles.headings.get(styleId)! : outline !== undefined ? Number(outline) + 1 : null;
    const list = a.pPr.includes("<w:numPr") || Boolean(styleId && styles.lists.has(styleId));
    return { index, text: a.text, editable: a.editable, reason: a.reason, heading, list, table: p.table, mixedFormatting: a.mixed };
  });
}

const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function runXml(text: string, rPr: string) {
  if (!text) return "";
  const parts = text.split(/(\t|\n)/).flatMap((part) => {
    if (part === "\t") return ["<w:tab/>"];
    if (part === "\n") return ["<w:br/>"];
    return part ? [`<w:t xml:space="preserve">${escapeText(part.replace(/‑/g, "-"))}</w:t>`] : [];
  });
  return `<w:r>${rPr}${parts.join("")}</w:r>`;
}

export type DocxEdit = { index: number; text: string };

export function applyDocxEditsToXml(documentXml: string, edits: DocxEdit[]): string {
  const paras = paragraphs(documentXml);
  const byIndex = new Map<number, string>();
  for (const e of edits) {
    if (!Number.isInteger(e.index) || e.index < 0 || e.index >= paras.length) throw new DocxEditError(`Paragraphe ${e.index} introuvable : le document a peut-être changé.`);
    byIndex.set(e.index, e.text.replace(/\r\n?/g, "\n").replace(INVALID_XML_CHARS, ""));
  }
  let out = documentXml;
  // De la fin vers le début : les positions des paragraphes précédents restent valables.
  for (const index of [...byIndex.keys()].sort((a, b) => b - a)) {
    const p = paras[index];
    const a = analyze(documentXml, p);
    if (!a.editable) throw new DocxEditError(`Le paragraphe ${index + 1} n'est pas modifiable (${a.reason}).`);
    const text = byIndex.get(index)!;
    if (text === a.text) continue;
    const openTag = p.openEnd === p.end ? p.openTag.replace(/\s*\/>$/, ">") : p.openTag;
    const rebuilt = `${openTag}${a.pPr}${a.bookmarksStart.join("")}${runXml(text, a.firstRPr)}${a.bookmarksEnd.join("")}</w:p>`;
    out = out.slice(0, p.start) + rebuilt + out.slice(p.end);
  }
  return out;
}

const DOCX_FILES = (n: string) => n === "word/document.xml" || n === "word/styles.xml";

export function readDocxBlocks(data: Uint8Array): DocxBlock[] {
  const files = readZip(data, DOCX_FILES);
  const xml = utf8(files["word/document.xml"]);
  if (!xml.includes("<w:body")) throw new DocxEditError("Ce fichier n'est pas un document Word lisible.");
  return docxBlocksFromXml(xml, utf8(files["word/styles.xml"]));
}

/** Nouveau fichier .docx : toutes les entrées de l'archive d'origine, seul word/document.xml étant remplacé. */
export function rewriteDocx(data: Uint8Array, edits: DocxEdit[]): Uint8Array {
  const files = readZip(data, () => true);
  const xml = utf8(files["word/document.xml"]);
  if (!xml.includes("<w:body")) throw new DocxEditError("Ce fichier n'est pas un document Word lisible.");
  files["word/document.xml"] = new TextEncoder().encode(applyDocxEditsToXml(xml, edits));
  return zipSync(files, { level: 6 });
}
