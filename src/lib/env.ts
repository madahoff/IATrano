import "server-only";
import { z } from "zod";

const boolish = z
  .enum(["true", "false", "1", "0", "auto"])
  .optional()
  .transform((v) => (v === "1" ? "true" : v === "0" ? "false" : v));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL est requis"),
  AUTH_SECRET: z.string().optional(),
  SUPERADMIN_EMAIL: z.string().optional(),
  SUPERADMIN_PASSWORD: z.string().optional(),
  SUPERADMIN_NAME: z.string().optional(),
  AI_PROVIDER: z.enum(["ollama", "openai"]).default("ollama"),
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_URL_ALLOWLIST: z.string().optional(),
  COOKIE_SECURE: boolish.default("auto"),
  TRUST_PROXY: boolish.default("false"),
  RATE_LIMIT_GENERATIONS_PER_MINUTE: z.coerce.number().int().positive().default(20),
  IATRANO_IN_DOCKER: boolish.default("false"),
});

export type ServerEnv = z.infer<typeof schema> & { authSecret: string };

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuration invalide : ${issues}`);
  }
  const data = parsed.data;
  let authSecret = data.AUTH_SECRET ?? "";
  if (authSecret.length < 32) {
    if (data.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET doit contenir au moins 32 caractères en production (openssl rand -base64 48).");
    }
    // Développement uniquement : secret dérivé de l'URL de la base, stable entre redémarrages.
    authSecret = `dev-insecure-secret::${data.DATABASE_URL}`;
  }
  cached = { ...data, authSecret };
  return cached;
}
