// Lecture et écriture CSV pour l'éditeur tabulaire (client et serveur). Contrairement à l'indexation
// (lib/documents/extract/text.ts), toutes les lignes sont conservées, y compris vides, pour réécrire le fichier
// sans perte, avec son séparateur et ses fins de ligne d'origine.

export type CsvTable = { rows: string[][]; delimiter: string; lineEnding: "\n" | "\r\n"; trailingNewline: boolean };

export function detectDelimiter(text: string) {
  const firstLine = text.slice(0, text.search(/\r?\n/) >= 0 ? text.search(/\r?\n/) : undefined);
  return [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsvTable(input: string, delimiter = detectDelimiter(input)): CsvTable {
  const text = input.replace(/^﻿/, "");
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /\r?\n$/.test(text);
  const body = trailingNewline ? text.replace(/\r?\n$/, "") : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (body.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, delimiter, lineEnding, trailingNewline };
}

function quote(value: string, delimiter: string) {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeCsv(table: CsvTable): string {
  // Lignes de longueurs inégales conservées telles quelles : l'éditeur complète lui-même les lignes quand il ajoute une colonne.
  const lines = table.rows.map((r) => r.map((v) => quote(v, table.delimiter)).join(table.delimiter));
  return lines.join(table.lineEnding) + (table.trailingNewline && lines.length ? table.lineEnding : "");
}
