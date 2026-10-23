import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { badRequest } from "@/lib/errors";

// Stockage des fichiers originaux et des dérivés (pages rendues, images clés, audio) sur disque.
// Arborescence : <racine>/<projectId>/<documentId>/… — chemins toujours construits par le serveur, jamais
// à partir d'un nom fourni par l'utilisateur, et vérifiés pour ne jamais sortir de la racine.

// Les commentaires turbopackIgnore excluent ces accès dynamiques du traçage de la sortie standalone
// (sinon tout le dépôt y serait copié) : ils visent des fichiers de données, jamais du code.
export function storageRoot() {
  return path.resolve(/* turbopackIgnore: true */ process.env.DOCUMENT_STORAGE_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), "data", "documents"));
}

export function resolveStored(relative: string) {
  const root = storageRoot();
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Chemin de stockage invalide.");
  return full;
}

export const documentDir = (projectId: string, documentId: string) => path.join(projectId, documentId);

const ID = /^[a-z0-9]{8,40}$/i;

export async function ensureDocumentDir(projectId: string, documentId: string, sub?: string) {
  if (!ID.test(projectId) || !ID.test(documentId)) throw new Error("Identifiant invalide.");
  const rel = sub ? path.join(documentDir(projectId, documentId), sub) : documentDir(projectId, documentId);
  await mkdir(resolveStored(rel), { recursive: true });
  return rel;
}

export type ReceivedFile = { tempPath: string; size: number; checksum: string; head: Buffer };

/**
 * Écrit un flux entrant dans un fichier temporaire en calculant son empreinte, et l'interrompt dès que
 * la taille maximale est dépassée (le fichier n'est jamais chargé entièrement en mémoire).
 */
export async function receiveStream(body: ReadableStream<Uint8Array> | Readable, maxBytes: number): Promise<ReceivedFile> {
  const tmpDir = resolveStored(".incoming");
  await mkdir(tmpDir, { recursive: true });
  const tempPath = path.join(tmpDir, randomUUID());
  const hash = createHash("sha256");
  let size = 0;
  const headParts: Buffer[] = [];
  let headSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(badRequest(`Fichier trop volumineux (maximum ${Math.round(maxBytes / 1024 / 1024)} Mo).`, "file_too_large"));
      hash.update(chunk);
      if (headSize < 16384) {
        headParts.push(chunk.subarray(0, 16384 - headSize));
        headSize += Math.min(chunk.length, 16384 - headSize);
      }
      cb(null, chunk);
    },
  });
  const source = body instanceof Readable ? body : Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
  try {
    await pipeline(source, meter, createWriteStream(tempPath, { mode: 0o600 }));
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
  return { tempPath, size, checksum: hash.digest("hex"), head: Buffer.concat(headParts) };
}

export async function moveIntoPlace(tempPath: string, relative: string) {
  const full = resolveStored(relative);
  await mkdir(path.dirname(full), { recursive: true });
  await rename(tempPath, full);
}

export async function removeDocumentFiles(projectId: string, documentId: string) {
  if (!ID.test(projectId) || !ID.test(documentId)) return;
  await rm(resolveStored(documentDir(projectId, documentId)), { recursive: true, force: true });
}

export async function removeProjectFiles(projectId: string) {
  if (!ID.test(projectId)) return;
  await rm(resolveStored(projectId), { recursive: true, force: true });
}

export async function discardTemp(tempPath: string) {
  await rm(tempPath, { force: true });
}

export async function fileSize(relative: string) {
  return (await stat(/* turbopackIgnore: true */ resolveStored(relative))).size;
}

export function readStored(relative: string, range?: { start: number; end: number }) {
  return createReadStream(/* turbopackIgnore: true */ resolveStored(relative), range);
}

export async function readHead(relative: string, bytes = 16384) {
  const fh = await open(/* turbopackIgnore: true */ resolveStored(relative), "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
