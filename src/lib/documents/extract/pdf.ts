import "server-only";
import path from "node:path";
import { runTool } from "../tools";
import type { ExtractedUnit } from "../types";

// PDF via poppler : pdfinfo (pages, métadonnées), pdftotext page par page (ordre de lecture),
// pdftoppm pour rendre en image les pages sans texte exploitable (OCR).

export type PdfInfo = { pages: number; encrypted: boolean; metadata: Record<string, string> };

export async function pdfInfo(file: string, signal?: AbortSignal): Promise<PdfInfo> {
  const { stdout } = await runTool("pdfinfo", ["-isodates", file], { timeoutMs: 30_000, signal });
  const metadata: Record<string, string> = {};
  for (const line of stdout.toString("utf8").split("\n")) {
    const m = /^([A-Za-z ]+):\s+(.*)$/.exec(line);
    if (m) metadata[m[1].trim()] = m[2].trim();
  }
  const pages = Number(metadata.Pages);
  if (!Number.isFinite(pages) || pages < 1) throw new Error("Nombre de pages illisible : PDF endommagé ?");
  const keep = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Page size"];
  return { pages, encrypted: /^yes/i.test(metadata.Encrypted ?? ""), metadata: Object.fromEntries(Object.entries(metadata).filter(([k, v]) => keep.includes(k) && v)) };
}

/** Texte « exploitable » : assez de caractères et peu de symboles de remplacement (police sans table Unicode). */
export function isUsableText(text: string) {
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (letters < 30) return false;
  const garbage = (text.match(/[�\u0000-\u0008]/g) ?? []).length;
  return garbage / Math.max(1, text.length) < 0.05;
}

/** Extrait les pages [from, to] (1-based) ; une page sans texte exploitable est marquée pour l'OCR. */
export async function extractPdfPages(file: string, from: number, to: number, signal?: AbortSignal): Promise<ExtractedUnit[]> {
  const { stdout } = await runTool("pdftotext", ["-enc", "UTF-8", "-f", String(from), "-l", String(to), file, "-"], { timeoutMs: 180_000, signal, maxBuffer: 256 * 1024 * 1024 });
  const pages = stdout.toString("utf8").split("\f");
  const units: ExtractedUnit[] = [];
  for (let n = from; n <= to; n++) {
    const raw = (pages[n - from] ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
    const usable = isUsableText(raw);
    units.push({
      number: n,
      label: `Page ${n}`,
      method: usable ? "TEXT" : "NONE",
      status: usable ? "OK" : raw ? "PARTIAL" : "EMPTY",
      text: raw,
      needsOcr: !usable,
    });
  }
  return units;
}

/** Rend une page en PNG (niveaux de gris) pour l'OCR ou l'analyse visuelle. */
export async function renderPdfPage(file: string, page: number, outDirAbs: string, dpi = 200, signal?: AbortSignal): Promise<string> {
  const base = path.join(outDirAbs, `page-${String(page).padStart(5, "0")}`);
  // -scale-to borne le côté le plus long : une page au format démesuré ne produit pas une image géante.
  await runTool("pdftoppm", ["-f", String(page), "-l", String(page), "-r", String(dpi), "-scale-to", "2800", "-gray", "-png", "-singlefile", file, base], { timeoutMs: 120_000, signal });
  return `${base}.png`;
}

