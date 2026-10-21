import { isIP } from "node:net";

// Classification des adresses IP pour la récupération de pages Web (protection SSRF).
// Seules les adresses unicast publiques sont autorisées : boucle locale, réseaux privés, lien local
// (dont les métadonnées cloud 169.254.169.254), CGNAT, multicast, réservées et documentation sont refusés.

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], // « ce réseau »
  ["10.0.0.0", 8], // privé
  ["100.64.0.0", 10], // CGNAT (Tailscale…)
  ["127.0.0.0", 8], // boucle locale
  ["169.254.0.0", 16], // lien local, métadonnées cloud
  ["172.16.0.0", 12], // privé (dont réseaux Docker)
  ["192.0.0.0", 24], // IETF
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // relais 6to4
  ["192.168.0.0", 16], // privé
  ["198.18.0.0", 15], // tests de performance
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // réservé + diffusion
];

const V4_RANGES = V4_BLOCKS.map(([base, bits]) => {
  const start = ipv4ToInt(base)!;
  return { start, end: start + 2 ** (32 - bits) - 1 };
});

export function isPublicIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return !V4_RANGES.some((r) => n >= r.start && n <= r.end);
}

/** Développe une IPv6 (y compris les formes « :: » et IPv4 imbriquée) en 8 groupes de 16 bits. */
function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  const v4 = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    addr = `${addr.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

export function isPublicIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4 imbriquée : ::ffff:a.b.c.d (mappée) et ::a.b.c.d (compatible, obsolète) → règles IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPublicIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  // 64:ff9b::/96 (NAT64) → l'IPv4 traduite doit elle-même être publique.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 lien local
  if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 site local (obsolète)
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4 (peut encapsuler une IPv4 privée)
  if (first === 0x2001 && g[1] === 0) return false; // Teredo
  if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard-only
  // Seul l'espace unicast global 2000::/3 est autorisé.
  return (first & 0xe000) === 0x2000;
}

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, ""));
  if (v === 4) return isPublicIPv4(ip);
  if (v === 6) return isPublicIPv6(ip);
  return false;
}
