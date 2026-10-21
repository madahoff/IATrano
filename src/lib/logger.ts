import "server-only";
import type { LogLevel, Prisma } from "@prisma/client";
import { db } from "./db";

const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization|cookie/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[masqué]" : redact(v, depth + 1);
  return out;
}

/** Journalise un événement technique (console + table ErrorLog consultable par l'administration). */
export async function logEvent(
  level: LogLevel,
  source: string,
  message: string,
  details?: Record<string, unknown>,
  userId?: string,
) {
  const safe = details ? (redact(details) as Prisma.InputJsonValue) : undefined;
  const line = `[${level}] ${source}: ${message}`;
  if (level === "ERROR") console.error(line, safe ?? "");
  else if (level === "WARN") console.warn(line, safe ?? "");
  else console.info(line);
  try {
    await db.errorLog.create({
      data: { level, source, message: message.slice(0, 2000), details: safe, userId },
    });
  } catch {
    // La base peut être indisponible : la console reste la source de vérité.
  }
}

export function errorDetails(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return {
      name: err.name,
      message: err.message,
      cause: cause instanceof Error ? { name: cause.name, message: cause.message, code: (cause as { code?: string }).code } : cause,
    };
  }
  return { value: String(err) };
}
