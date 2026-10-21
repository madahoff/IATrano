import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import zlib from "node:zlib";
import { isPublicIp } from "./ip";

// Récupération de pages Web non fiables (URL issues des résultats du moteur de recherche).
// - protocoles http/https uniquement, ports standard, aucun identifiant dans l'URL ;
// - résolution DNS validée puis ÉPINGLÉE : la connexion utilise exactement les adresses vérifiées
//   (pas de fenêtre de « DNS rebinding ») ; toute adresse non publique est refusée ;
// - redirections suivies manuellement, chaque destination étant revalidée ;
// - taille, durée et types de contenu bornés ; aucun cookie ni en-tête d'authentification envoyé.

export class FetchBlockedError extends Error {
  constructor(message: string, public readonly reason: "url" | "address" | "redirect" | "type" | "size" | "status" | "network" | "timeout" | "aborted") {
    super(message);
    this.name = "FetchBlockedError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".localdomain"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "host.docker.internal", "gateway.docker.internal", "kubernetes.default"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);

export type UrlValidation = { ok: true; url: URL } | { ok: false; error: string };

/** Validation syntaxique d'une URL à récupérer (avant toute résolution DNS). */
export function validatePublicUrl(input: string, base?: string): UrlValidation {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    return { ok: false, error: "URL malformée." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: `Protocole non autorisé (${url.protocol}).` };
  if (url.username || url.password) return { ok: false, error: "URL contenant des identifiants." };
  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, error: `Port non autorisé (${url.port}).` };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "Hôte manquant." };
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (!isPublicIp(literal)) return { ok: false, error: "Adresse IP interne ou réservée refusée." };
  } else {
    if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, error: "Nom d'hôte interne refusé." };
    // Les noms sans point (« intranet », « db », « searxng »…) désignent des machines du réseau local ou de Docker.
    if (!host.includes(".")) return { ok: false, error: "Nom d'hôte non qualifié refusé." };
    // Formes numériques détournées (« 2130706433 », « 0x7f.1 ») interprétées comme des IP par certains résolveurs.
    if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+/i.test(host)) return { ok: false, error: "Adresse numérique non standard refusée." };
  }
  url.hash = "";
  return { ok: true, url };
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

let resolver: Resolver = systemResolver;
/** Tests uniquement : remplace la résolution DNS. */
export function setResolverForTests(r: Resolver | null) {
  resolver = r ?? systemResolver;
}

/** Résout l'hôte et refuse si UNE des adresses n'est pas publique. */
export async function resolvePublic(hostname: string): Promise<LookupAddress[]> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(literal);
  const addrs = family ? [{ address: literal, family }] : await resolver(hostname).catch(() => {
    throw new FetchBlockedError(`Nom de domaine introuvable (${hostname}).`, "network");
  });
  if (addrs.length === 0) throw new FetchBlockedError(`Aucune adresse pour ${hostname}.`, "network");
  const bad = addrs.find((a) => !isPublicIp(a.address));
  if (bad) throw new FetchBlockedError(`${hostname} pointe vers une adresse interne (${bad.address}) : accès refusé.`, "address");
  return addrs;
}

/** lookup() épinglé : renvoie uniquement les adresses déjà validées pour cet hôte. */
function pinnedLookup(addrs: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const opts = typeof options === "object" && options ? options : {};
    if ((opts as { all?: boolean }).all) (callback as (e: null, a: LookupAddress[]) => void)(null, addrs);
    else callback(null, addrs[0].address, addrs[0].family);
  };
}

export type FetchedPage = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  bytes: number;
};

export type SafeFetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: RegExp;
};

const DEFAULT_ACCEPT = /^(text\/html|application\/xhtml\+xml|text\/plain)/i;
const USER_AGENT = "Mozilla/5.0 (compatible; IATranoBot/0.1; recherche documentaire privée)";

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };

function requestOnce(url: URL, addrs: LookupAddress[], signal: AbortSignal, maxBytes: number, accept: RegExp): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addrs),
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
          "accept-language": "fr,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
        // Pas d'agent partagé : aucune connexion réutilisée vers une adresse non revalidée.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const type = String(res.headers["content-type"] ?? "");
        if (status >= 200 && status < 300 && type && !accept.test(type)) {
          res.destroy();
          reject(new FetchBlockedError(`Type de contenu non pris en charge (${type.split(";")[0]}).`, "type"));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes * 4) {
          res.destroy();
          reject(new FetchBlockedError("Page trop volumineuse.", "size"));
          return;
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          chunks.push(c);
          // Limite appliquée APRÈS décompression (protection contre les « bombes » gzip).
          if (size >= maxBytes) {
            truncated = true;
            res.destroy();
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
          }
        });
        stream.on("end", () => {
          if (!truncated) resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
        });
        stream.on("error", (e) => {
          if (!truncated) reject(e);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function decodeBody(buf: Buffer, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = buf.subarray(0, 2048).toString("latin1");
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase()).decode(buf);
    } catch {
      // encodage inconnu : essai suivant
    }
  }
  return buf.toString("utf8");
}

/** Récupère une page publique en appliquant toutes les protections. Lève FetchBlockedError. */
export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const maxRedirects = opts.maxRedirects ?? 4;
  const accept = opts.accept ?? DEFAULT_ACCEPT;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

  const first = validatePublicUrl(input);
  if (!first.ok) throw new FetchBlockedError(first.error, "url");
  let url = first.url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const addrs = await resolvePublic(url.hostname);
    let res: RawResponse;
    try {
      res = await requestOnce(url, addrs, signal, maxBytes, accept);
    } catch (err) {
      if (err instanceof FetchBlockedError) throw err;
      if (opts.signal?.aborted) throw new FetchBlockedError("Récupération annulée.", "aborted");
      if (signal.aborted) throw new FetchBlockedError(`Délai de ${Math.round(timeoutMs / 1000)} s dépassé.`, "timeout");
      const code = (err as { code?: string }).code ?? "";
      throw new FetchBlockedError(`Connexion impossible${code ? ` (${code})` : ""}.`, "network");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) throw new FetchBlockedError(`Redirection ${res.status} sans destination.`, "redirect");
      if (hop === maxRedirects) throw new FetchBlockedError("Trop de redirections.", "redirect");
      const next = validatePublicUrl(location, url.toString());
      if (!next.ok) throw new FetchBlockedError(`Redirection refusée : ${next.error}`, "redirect");
      // Pas de rétrogradation https → http.
      if (url.protocol === "https:" && next.url.protocol === "http:") throw new FetchBlockedError("Redirection vers http refusée.", "redirect");
      url = next.url;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new FetchBlockedError(`Le site a répondu ${res.status}.`, "status");
    const contentType = String(res.headers["content-type"] ?? "text/html");
    return {
      url: input,
      finalUrl: url.toString(),
      status: res.status,
      contentType,
      body: decodeBody(res.body, contentType),
      truncated: res.truncated,
      bytes: res.body.length,
    };
  }
  throw new FetchBlockedError("Trop de redirections.", "redirect");
}
