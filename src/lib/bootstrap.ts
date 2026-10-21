import "server-only";
import { db } from "./db";
import { hashPassword } from "./auth/password";
import { emailSchema } from "./users/service";
import { getAppSettings } from "./settings/service";
import { errorDetails, logEvent } from "./logger";

const SUPERADMIN_MIN_PASSWORD = 12;

/**
 * Initialisation idempotente au démarrage :
 *  - crée la configuration globale si absente ;
 *  - crée le super-administrateur depuis SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD uniquement s'il n'existe
 *    encore AUCUN super-administrateur. Un redémarrage ne recrée rien et ne réinitialise jamais un mot de passe.
 */
export async function bootstrap(): Promise<void> {
  await getAppSettings();
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  const existing = await db.user.count({ where: { role: "SUPERADMIN" } });
  if (existing > 0) return;

  // Lu directement (et non via le cache de env()) : exécuté une seule fois par démarrage.
  const email = emailSchema.safeParse(process.env.SUPERADMIN_EMAIL ?? "");
  const password = process.env.SUPERADMIN_PASSWORD ?? "";
  if (!email.success || password.length < SUPERADMIN_MIN_PASSWORD) {
    await logEvent(
      "WARN",
      "bootstrap",
      `Aucun super-administrateur : définissez SUPERADMIN_EMAIL et SUPERADMIN_PASSWORD (≥ ${SUPERADMIN_MIN_PASSWORD} caractères) puis redémarrez.`,
    );
    return;
  }
  const taken = await db.user.findUnique({ where: { email: email.data } });
  if (taken) {
    await logEvent("WARN", "bootstrap", `Le compte ${email.data} existe déjà sans être super-administrateur : aucune élévation automatique.`);
    return;
  }
  await db.user.create({
    data: {
      email: email.data,
      name: process.env.SUPERADMIN_NAME?.trim() || "Super administrateur",
      role: "SUPERADMIN",
      passwordHash: await hashPassword(password),
    },
  });
  await logEvent("INFO", "bootstrap", `Super-administrateur ${email.data} créé.`);
}

let done: Promise<void> | null = null;

/** Exécute bootstrap() une fois par processus, avec quelques tentatives si la base démarre encore. */
export function ensureBootstrapped(): Promise<void> {
  done ??= (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await bootstrap();
        return;
      } catch (err) {
        if (attempt >= 5) {
          console.error("[bootstrap] échec de l'initialisation", errorDetails(err));
          done = null;
          return;
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  })();
  return done;
}
