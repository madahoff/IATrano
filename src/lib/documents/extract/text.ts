import type { ExtractedUnit } from "../types";

// Textes, Markdown, JSON et CSV : découpés en « parties » (aucune pagination d'origine n'existe).

const PART_CHARS = 6000;

export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = buf.toString("utf8").replace(/^﻿/, "");
  // Fichier Latin-1 / Windows-1252 : trop de caractères de remplacement en UTF-8.
  const bad = (text.match(/�/g) ?? []).length;
  return bad > 5 && bad > text.length / 1000 ? buf.toString("latin1") : text;
}

/** Parties de ~6 000 caractères, coupées sur une ligne vide (ou avant un titre Markdown). */
export function splitParts(text: string): ExtractedUnit[] {
  const clean = text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  const units: ExtractedUnit[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + PART_CHARS);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const heading = window.lastIndexOf("\n#");
      const blank = window.lastIndexOf("\n\n");
      const cut = heading > PART_CHARS / 2 ? heading : blank > PART_CHARS / 3 ? blank : window.lastIndexOf("\n");
      if (cut > 0) end = start + cut;
    }
    const value = clean.slice(start, end).trim();
    if (value) units.push({ number: units.length + 1, label: `Partie ${units.length + 1}`, method: "TEXT", status: "OK", text: value });
    start = end;
  }
  return units;
}

/** CSV / TSV : lecteur conforme RFC 4180 (guillemets, séparateurs et retours à la ligne dans les champs). */
export function parseCsv(text: string, maxRows = 200_000): { rows: string[][]; truncated: boolean } {
  const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : undefined);
  const delim = [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 };
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return { rows, truncated: false };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** Tableau découpé en blocs de lignes ; chaque bloc répète la ligne d'en-tête. */
export function csvUnits(text: string, rowsPerUnit = 400): { units: ExtractedUnit[]; warnings: string[] } {
  const { rows, truncated } = parseCsv(text);
  if (!rows.length) return { units: [], warnings: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${[...r.map(cell), ...Array(width - r.length).fill("")].join(" | ")} |`;
  const header = rows[0];
  const units: ExtractedUnit[] = [];
  for (let i = 1; i < Math.max(2, rows.length); i += rowsPerUnit) {
    const slice = rows.slice(i, i + rowsPerUnit);
    const from = i + 1;
    const to = i + slice.length;
    units.push({
      number: units.length + 1,
      label: slice.length ? `Lignes ${from}–${to}` : "En-tête",
      method: "TEXT",
      status: "OK",
      text: [line(header), `|${" --- |".repeat(width)}`, ...slice.map(line)].join("\n"),
    });
  }
  return { units, warnings: truncated ? [`Seules les ${rows.length} premières lignes du fichier ont été indexées.`] : [] };
}

export function jsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
