import "server-only";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

// Outils système optionnels (poppler, ffmpeg, tesseract) : détectés à l'exécution, jamais supposés présents.
// Chaque appel est borné en durée et en volume de sortie, et reçoit ses arguments sans passer par un shell.

export type ToolName = "pdftotext" | "pdfinfo" | "pdftoppm" | "ffmpeg" | "ffprobe" | "tesseract";

const found = new Map<ToolName, string | null>();

async function which(bin: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // absent de ce répertoire
    }
  }
  return null;
}

export async function toolPath(name: ToolName): Promise<string | null> {
  if (!found.has(name)) found.set(name, await which(name));
  return found.get(name) ?? null;
}

export async function toolsStatus(): Promise<Record<ToolName, boolean>> {
  const names: ToolName[] = ["pdftotext", "pdfinfo", "pdftoppm", "ffmpeg", "ffprobe", "tesseract"];
  const entries = await Promise.all(names.map(async (n) => [n, Boolean(await toolPath(n))] as const));
  return Object.fromEntries(entries) as Record<ToolName, boolean>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: "missing" | "timeout" | "failed",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const MISSING_HINTS: Record<ToolName, string> = {
  pdftotext: "Installez poppler-utils (apt install poppler-utils / apk add poppler-utils).",
  pdfinfo: "Installez poppler-utils (apt install poppler-utils / apk add poppler-utils).",
  pdftoppm: "Installez poppler-utils (apt install poppler-utils / apk add poppler-utils).",
  ffmpeg: "Installez ffmpeg (apt install ffmpeg / apk add ffmpeg).",
  ffprobe: "Installez ffmpeg (apt install ffmpeg / apk add ffmpeg).",
  tesseract: "Installez tesseract-ocr, ou laissez l'OCR intégré (tesseract.js) prendre le relais.",
};

export async function runTool(
  name: ToolName,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal; encoding?: "utf8" | "buffer" } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  const bin = await toolPath(name);
  if (!bin) throw new ToolError(`Outil « ${name} » introuvable sur le serveur. ${MISSING_HINTS[name]}`, "missing");
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs ?? 120_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: "buffer", killSignal: "SIGKILL", signal: opts.signal, windowsHide: true },
      (err, stdout, stderr) => {
        const errText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.killed || e.signal === "SIGKILL") return reject(new ToolError(`${name} : délai dépassé.`, "timeout"));
          return reject(new ToolError(`${name} a échoué : ${errText.trim().slice(0, 300) || e.message}`, "failed"));
        }
        resolve({ stdout: stdout as Buffer, stderr: errText });
      },
    );
  });
}
