import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt (RFC 7914) : algorithme résistant au matériel spécialisé, intégré à Node.js.
// Format stocké : scrypt$N$r$p$sel$hash (base64url) — les paramètres voyagent avec le hash.
const DEFAULTS = { N: 2 ** 15, r: 8, p: 1, keyLen: 64 };

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function maxmem(N: number, r: number) {
  return 128 * N * r * 2;
}

export async function hashPassword(password: string, params: Partial<typeof DEFAULTS> = {}): Promise<string> {
  const { N, r, p, keyLen } = { ...DEFAULTS, ...params };
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, keyLen, { N, r, p, maxmem: maxmem(N, r) });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nS, rS, pS, saltS, hashS] = parts;
  const N = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const expected = Buffer.from(hashS, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltS, "base64url"), expected.length, {
    N,
    r,
    p,
    maxmem: maxmem(N, r),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Hash factice pour égaliser le temps de réponse quand l'e-mail n'existe pas.
let dummyHash: Promise<string> | null = null;
export function getDummyHash() {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

export const PASSWORD_MIN_LENGTH = 10;
