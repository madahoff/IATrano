import { unzipSync } from "fflate";

// Lecture sûre des conteneurs ZIP (DOCX, PPTX, XLSX) : la taille décompressée annoncée est vérifiée AVANT
// décompression (protection contre les « bombes » de décompression), entrée par entrée et au total.

export type ZipLimits = { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number; maxRatio: number };

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxEntryBytes: 200 * 1024 * 1024, maxTotalBytes: 600 * 1024 * 1024, maxRatio: 200 };

export class ZipLimitError extends Error {}

export function readZip(data: Uint8Array, wanted: (name: string) => boolean, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Record<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  return unzipSync(data, {
    filter(file) {
      entries++;
      if (entries > limits.maxEntries) throw new ZipLimitError(`Archive suspecte : plus de ${limits.maxEntries} entrées.`);
      // Contrôles sur TOUTES les entrées (y compris celles qu'on ne lit pas : un autre lecteur pourrait les décompresser).
      if (file.originalSize > limits.maxEntryBytes) throw new ZipLimitError(`Archive suspecte : l'entrée ${file.name} dépasse la taille autorisée une fois décompressée.`);
      if (file.size > 0 && file.originalSize / file.size > limits.maxRatio && file.originalSize > 10 * 1024 * 1024) {
        throw new ZipLimitError(`Archive suspecte : taux de compression anormal pour ${file.name}.`);
      }
      total += file.originalSize;
      if (total > limits.maxTotalBytes) throw new ZipLimitError("Archive suspecte : taille décompressée totale excessive.");
      if (file.name.includes("..") || file.name.startsWith("/")) return false;
      return wanted(file.name);
    },
  });
}

export const utf8 = (data: Uint8Array | undefined) => (data ? new TextDecoder("utf-8").decode(data) : "");

/** Décode les entités XML de base (le contenu OOXML est déjà en UTF-8). */
export function xmlText(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Vérifie les tailles annoncées d'une archive sans rien décompresser (avant de la confier à un autre lecteur). */
export function assertSafeZip(data: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS) {
  readZip(data, () => false, limits);
}
