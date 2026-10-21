// Canonicalisation d'URL pour détecter les doublons (www, paramètres de suivi, barre finale, ancre, AMP).

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|igshid|ref|ref_src|ref_url|src|source|cmpid|xtor|at_medium|at_campaign|_ga|yclid|spm)$/i;

export function canonicalKey(input: string): string {
  try {
    const u = new URL(input);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^(www\d?|m|mobile|amp)\./, "");
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    let path = u.pathname.replace(/\/(amp|index\.html?|index\.php)\/?$/i, "/").replace(/\/+$/, "");
    path = path || "/";
    const q = u.searchParams.toString();
    return `${u.hostname}${path}${q ? `?${q}` : ""}`;
  } catch {
    return input;
  }
}

/** Nettoie une URL pour l'affichage et le lien (sans paramètres de suivi, protocole conservé). */
export function cleanUrl(input: string): string {
  try {
    const u = new URL(input);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return input;
  }
}

/** Domaine « enregistrable » approximatif (exemple.co.uk, exemple.fr) pour comparer des sources. */
export function siteKey(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts.at(-2)!;
  const twoLevel = ["co", "com", "org", "net", "gov", "gouv", "ac", "edu", "ne", "or"].includes(sld);
  return parts.slice(twoLevel ? -3 : -2).join(".");
}
