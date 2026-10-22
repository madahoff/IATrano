import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Chiffrement des secrets stockés en base (AES-256-GCM). La clé est dérivée du secret maître
// (AUTH_SECRET) par HKDF avec un contexte propre à chaque usage : changer AUTH_SECRET rend les
// valeurs existantes illisibles (il faut alors les ressaisir), sans jamais exposer d'autre secret.

const VERSION = "v1";

function deriveKey(masterSecret: string, context: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterSecret, "iatrano-secret-box", context, 32));
}

export function sealSecret(plain: string, masterSecret: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterSecret, context), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

/** Renvoie null si la valeur est corrompue ou a été chiffrée avec un autre secret maître. */
export function openSecret(sealed: string, masterSecret: string, context: string): string | null {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterSecret, context), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
