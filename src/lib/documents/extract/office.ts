import path from "node:path";
import { readZip, utf8, xmlText } from "./zip";
import type { ExtractedUnit } from "../types";

// Présentations (PPTX) et classeurs (XLSX) lus directement depuis leur XML OOXML.

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function paragraphs(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g) ?? []) {
    const text = (p.match(/<a:t>([\s\S]*?)<\/a:t>|<a:t [^>]*>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => xmlText(t.replace(/<[^>]+>/g, ""))).join("");
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

function slideTables(xml: string): string[] {
  const tables: string[] = [];
  for (const tbl of xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/g) ?? []) {
    const rows = (tbl.match(/<a:tr[\s\S]*?<\/a:tr>/g) ?? []).map((tr) => (tr.match(/<a:tc[\s\S]*?<\/a:tc>/g) ?? []).map((tc) => cell(paragraphs(tc).join(" "))));
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
    tables.push([line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n"));
  }
  return tables;
}

export type PptxResult = { units: ExtractedUnit[]; images: Array<{ slide: number; name: string; data: Uint8Array }>; title: string | null };

export function extractPptx(data: Uint8Array): PptxResult {
  const files = readZip(data, (n) => /^ppt\/(slides|notesSlides)\/(_rels\/)?[^/]+\.xml(\.rels)?$/.test(n) || /^ppt\/media\//.test(n) || n === "docProps/core.xml");
  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const units: ExtractedUnit[] = [];
  const images: PptxResult["images"] = [];
  slideNames.forEach((name, i) => {
    const number = i + 1;
    const xml = utf8(files[name]);
    // Titre : forme de type title/ctrTitle ; sinon premier paragraphe.
    const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>|<p:sp [\s\S]*?<\/p:sp>/g) ?? [];
    let title: string | null = null;
    const body: string[] = [];
    for (const sp of shapes) {
      const paras = paragraphs(sp);
      if (!paras.length) continue;
      if (!title && /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(sp)) title = paras.join(" ");
      else body.push(...paras.map((p) => (paras.length > 1 ? `- ${p}` : p)));
    }
    if (!title && body.length) title = body.shift()!.replace(/^- /, "");
    const tables = slideTables(xml);
    const relsXml = utf8(files[`ppt/slides/_rels/${path.basename(name)}.rels`]);
    const notesTarget = /Target="\.\.\/notesSlides\/([^"]+)"/.exec(relsXml)?.[1];
    const notes = notesTarget ? paragraphs(utf8(files[`ppt/notesSlides/${notesTarget}`])).filter((p) => !/^\d+$/.test(p)) : [];
    for (const m of relsXml.matchAll(/Target="\.\.\/media\/([^"]+\.(?:png|jpe?g|gif|bmp|tiff?))"/gi)) {
      const media = files[`ppt/media/${m[1]}`];
      if (media && media.length > 20_000) images.push({ slide: number, name: m[1], data: media });
    }
    const text = [`# ${title ?? `Diapositive ${number}`}`, ...body, ...tables, ...(notes.length ? [`> Notes : ${notes.join(" ")}`] : [])].join("\n\n");
    units.push({ number, label: `Diapositive ${number}`, method: "TEXT", status: body.length || tables.length || title ? "OK" : "EMPTY", text });
  });
  const core = utf8(files["docProps/core.xml"]);
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1];
  return { units, images, title: title ? xmlText(title) : null };
}

function colIndex(ref: string) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export type XlsxSheet = { name: string; rows: Array<{ number: number; values: string[] }>; truncated: boolean };

/** Valeurs brutes des feuilles (valeurs enregistrées, formules non recalculées), avec le numéro de ligne d'origine. */
export function readXlsxSheets(data: Uint8Array, maxRows = 20_000): XlsxSheet[] {
  const files = readZip(data, (n) => n === "xl/workbook.xml" || n === "xl/sharedStrings.xml" || n === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = (utf8(files["xl/sharedStrings.xml"]).match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) => xmlText((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  const wb = utf8(files["xl/workbook.xml"]);
  const rels = utf8(files["xl/_rels/workbook.xml.rels"]);
  const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: xmlText(m[1]), target: new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels) }));
  return sheets.map((s, i) => {
    const target = (s.target?.[1] ?? s.target?.[2] ?? `worksheets/sheet${i + 1}.xml`).replace(/^\/?xl\//, "");
    const xml = utf8(files[`xl/${target}`]);
    const rows: XlsxSheet["rows"] = [];
    let truncated = false;
    for (const row of xml.match(/<row[\s\S]*?<\/row>/g) ?? []) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const values: string[] = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = /r="([A-Z]+)\d+"/.exec(c)?.[1] ?? "";
        const type = /t="(\w+)"/.exec(c)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        const inlineStr = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c)?.[1];
        let value = type === "s" && v !== undefined ? (shared[Number(v)] ?? "") : type === "inlineStr" ? xmlText(inlineStr ?? "") : v !== undefined ? xmlText(v) : "";
        if (type === "b") value = value === "1" ? "VRAI" : "FAUX";
        values[ref ? colIndex(ref) : values.length] = value;
      }
      const number = Number(/<row [^>]*r="(\d+)"/.exec(row)?.[1] ?? rows.length + 1);
      if (values.some((v) => v)) rows.push({ number, values: Array.from(values, (v) => v ?? "") });
    }
    return { name: s.name, rows, truncated };
  });
}

export function extractXlsx(data: Uint8Array, maxRows = 20_000): { units: ExtractedUnit[]; warnings: string[] } {
  const units: ExtractedUnit[] = [];
  const warnings: string[] = [];
  readXlsxSheets(data, maxRows).forEach((s, i) => {
    const rows = s.rows.map((r) => r.values.map(cell));
    if (s.truncated) warnings.push(`Feuille « ${s.name} » : seules les ${maxRows} premières lignes ont été indexées.`);
    const width = Math.max(0, ...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
    const table = rows.length ? [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n") : "";
    units.push({ number: i + 1, label: `Feuille ${s.name}`, method: "TEXT", status: rows.length ? "OK" : "EMPTY", text: `# Feuille : ${s.name}\n\n${table}`.trim() });
  });
  return { units, warnings };
}
