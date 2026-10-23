import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runTool, toolPath } from "./tools";
import { storageRoot } from "./storage";

// OCR : binaire tesseract s'il est installé (plus rapide), sinon tesseract.js (WebAssembly, sans paquet système).
// Les données de langue de tesseract.js sont téléchargées une fois puis conservées dans <stockage>/.ocr-cache.

export type OcrResult = { text: string; confidence: number | null; engine: "tesseract" | "tesseract.js" };

type Worker = { recognize: (image: string) => Promise<{ data: { text: string; confidence: number } }>; terminate: () => Promise<unknown> };

// `active` : reconnaissances en cours sur ce worker partagé (chat et traitement des documents de projet).
type SharedWorker = { langs: string; worker: Promise<Worker>; active: number };
const g = globalThis as unknown as { __iatranoOcr?: SharedWorker };

async function jsWorker(langs: string): Promise<Worker> {
  if (g.__iatranoOcr?.langs === langs) return g.__iatranoOcr.worker;
  if (g.__iatranoOcr) void g.__iatranoOcr.worker.then((w) => w.terminate()).catch(() => {});
  const cachePath = path.join(storageRoot(), ".ocr-cache");
  const worker = (async () => {
    await mkdir(cachePath, { recursive: true });
    const { createWorker } = await import("tesseract.js");
    return (await createWorker(langs.split("+"), 1, { cachePath, logger: () => {} })) as unknown as Worker;
  })();
  g.__iatranoOcr = { langs, worker, active: 0 };
  worker.catch(() => {
    if (g.__iatranoOcr?.worker === worker) g.__iatranoOcr = undefined;
  });
  return worker;
}

/** Confiance moyenne pondérée par la longueur des mots, à partir de la sortie TSV de tesseract. */
function tsvConfidence(tsv: string): number | null {
  let sum = 0;
  let weight = 0;
  for (const line of tsv.split("\n").slice(1)) {
    const cols = line.split("\t");
    const conf = Number(cols[10]);
    const word = cols[11]?.trim();
    if (!word || !Number.isFinite(conf) || conf < 0) continue;
    sum += conf * word.length;
    weight += word.length;
  }
  return weight ? sum / weight / 100 : null;
}

export async function ocrImage(file: string, langs: string, signal?: AbortSignal): Promise<OcrResult> {
  if (await toolPath("tesseract")) {
    const [text, tsv] = await Promise.all([
      runTool("tesseract", [file, "-", "-l", langs, "--psm", "3"], { timeoutMs: 180_000, signal }),
      runTool("tesseract", [file, "-", "-l", langs, "--psm", "3", "tsv"], { timeoutMs: 180_000, signal }),
    ]);
    return { text: text.stdout.toString("utf8").trim(), confidence: tsvConfidence(tsv.stdout.toString("utf8")), engine: "tesseract" };
  }
  let timer: NodeJS.Timeout | undefined;
  // Le démarrage du worker est lui aussi soumis au délai et à l'annulation (il peut ne jamais aboutir).
  const job = jsWorker(langs).then((worker) => {
    if (signal?.aborted) throw new Error("OCR annulé.");
    return worker.recognize(file);
  });
  job.catch(() => {}); // perdant éventuel de la course ci-dessous : son rejet ne doit pas remonter
  // jsWorker enregistre le worker de façon synchrone (sauf échec immédiat, où il n'y a rien à suivre).
  const used = g.__iatranoOcr;
  if (used) used.active++;
  try {
    const result = await Promise.race([
      job,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OCR : délai dépassé (3 min) pour cette image.")), 180_000);
        if (signal?.aborted) reject(new Error("OCR annulé."));
        signal?.addEventListener("abort", () => reject(new Error("OCR annulé.")), { once: true });
      }),
    ]);
    return { text: result.data.text.trim(), confidence: Number.isFinite(result.data.confidence) ? result.data.confidence / 100 : null, engine: "tesseract.js" };
  } catch (err) {
    // Délai dépassé ou annulation : le worker est arrêté (ce qui interrompt la reconnaissance) puis recréé au
    // prochain appel — seulement s'il s'agit toujours du worker courant et qu'aucune autre requête ne l'utilise.
    if (used && used.active === 1 && g.__iatranoOcr === used) {
      void used.worker.then((w) => w.terminate()).catch(() => {});
      g.__iatranoOcr = undefined;
    }
    throw err;
  } finally {
    if (used) used.active--;
    clearTimeout(timer);
  }
}

/** Nettoie le texte OCR : lignes vides multiples, césures, caractères isolés parasites. */
export function cleanOcrText(text: string) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => !/^[^\p{L}\p{N}]{1,3}$/u.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
