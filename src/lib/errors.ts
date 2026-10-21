export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = (msg = "Authentification requise.") => new AppError(401, "unauthorized", msg);
export const forbidden = (msg = "Accès refusé.") => new AppError(403, "forbidden", msg);
export const notFound = (msg = "Ressource introuvable.") => new AppError(404, "not_found", msg);
export const badRequest = (msg: string, code = "bad_request") => new AppError(400, code, msg);
export const tooManyRequests = (retryAfterSec: number) =>
  new AppError(429, "rate_limited", `Trop de requêtes. Réessayez dans ${retryAfterSec} s.`);
