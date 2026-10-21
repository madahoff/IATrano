import "server-only";
import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { AppError, badRequest, forbidden } from "./errors";
import { env } from "./env";
import { errorDetails, logEvent } from "./logger";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/**
 * Protection CSRF : les mutations doivent provenir de la même origine.
 * Les cookies sont déjà SameSite=Lax ; on vérifie en plus l'en-tête Origin quand il est présent.
 */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("Origine invalide.");
  }
  if (!host || originHost !== host.split(",")[0].trim()) throw forbidden("Requête d'origine croisée refusée.");
}

export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw badRequest("Content-Type application/json attendu.");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest("Corps JSON invalide.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "Données invalides.", "validation_error");
  }
  return parsed.data;
}

export function clientIp(req: Request): string {
  if (env().TRUST_PROXY === "true") {
    const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
    const real = req.headers.get("x-real-ip");
    if (real) return real;
  }
  return "local";
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Enveloppe commune des routes API : vérification d'origine, erreurs typées, aucune fuite de détails internes. */
export function route<C = unknown>(handler: Handler<C>, opts: { mutation?: boolean } = {}): Handler<C> {
  return async (req, ctx) => {
    try {
      if (opts.mutation ?? req.method !== "GET") assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof AppError) {
        const headers: Record<string, string> = {};
        if (err.status === 429) {
          const m = err.message.match(/(\d+) s/);
          if (m) headers["Retry-After"] = m[1];
        }
        return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers });
      }
      if (err instanceof z.ZodError) {
        return NextResponse.json({ error: { code: "validation_error", message: err.issues[0]?.message } }, { status: 400 });
      }
      await logEvent("ERROR", `api ${req.method} ${new URL(req.url).pathname}`, "Erreur inattendue", errorDetails(err));
      return NextResponse.json(
        { error: { code: "internal_error", message: "Erreur interne du serveur. Consultez le journal d'administration." } },
        { status: 500 },
      );
    }
  };
}
