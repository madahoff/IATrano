import { existsSync } from "node:fs";
import { ProviderError } from "./types";

// Validation prudente des URL de fournisseurs configurables par l'administration.
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "100.100.100.200", "[fd00:ec2::254]"]);

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

export function normalizeBaseUrl(input: string, allowlist?: string): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "L'adresse du serveur IA est vide." };
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "Adresse invalide. Exemple : http://192.168.1.20:11434" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Seuls les protocoles http et https sont autorisés." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "N'incluez pas d'identifiants dans l'URL ; utilisez le champ « clé d'API »." };
  }
  if (url.search || url.hash) return { ok: false, error: "L'adresse ne doit contenir ni paramètres ni ancre." };
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return { ok: false, error: "Cette adresse (service de métadonnées) est interdite." };
  if (allowlist?.trim()) {
    const allowed = allowlist
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(host)) {
      return { ok: false, error: `Hôte non autorisé par AI_URL_ALLOWLIST (${allowed.join(", ")}).` };
    }
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.protocol}//${url.host}${path}` };
}

function isLoopback(host: string) {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

export function inDocker(): boolean {
  if (process.env.IATRANO_IN_DOCKER === "true" || process.env.IATRANO_IN_DOCKER === "1") return true;
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

/** Convertit une erreur réseau Node (fetch failed + cause.code) en message compréhensible avec piste de résolution. */
export function describeNetworkError(err: unknown, baseUrl: string, timeoutMs: number): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  let host = baseUrl;
  let port = "";
  try {
    const u = new URL(baseUrl);
    host = u.hostname;
    port = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {}
  const docker = inDocker();
  if (e?.name === "AbortError") return new ProviderError("Génération annulée.", "aborted");
  if (e?.name === "TimeoutError") {
    return new ProviderError(
      `Le serveur IA (${baseUrl}) n'a pas répondu dans le délai de ${Math.round(timeoutMs / 1000)} s.`,
      "timeout",
      "Le modèle est peut-être en cours de chargement en mémoire (premier appel) ou la machine est saturée. Réessayez, ou augmentez le délai dans l'administration.",
    );
  }
  const code = e?.cause?.code ?? "";
  if (code === "ECONNREFUSED") {
    let hint = `Aucun service n'écoute sur ${host}:${port}. Vérifiez que le moteur IA est démarré et le port correct (Ollama : 11434, LM Studio : 1234, llama.cpp : 8080).`;
    if (docker && isLoopback(host)) {
      hint = `L'application tourne dans un conteneur Docker : « ${host} » désigne le conteneur lui-même, pas votre machine. Utilisez http://host.docker.internal:${port} (configuré via extra_hosts: host-gateway) ou l'IP de la machine sur le réseau local.`;
    } else if (host === "host.docker.internal" || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      hint = `Le conteneur atteint l'hôte, mais le moteur IA refuse la connexion. Ollama n'écoute par défaut que sur 127.0.0.1 : configurez OLLAMA_HOST=0.0.0.0:11434 (voir README, section Docker) puis redémarrez Ollama.`;
    }
    return new ProviderError(`Connexion refusée par ${host}:${port}.`, "unreachable", hint);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    const hint =
      host === "host.docker.internal"
        ? docker
          ? "host.docker.internal n'est pas résolu : ajoutez « extra_hosts: - host.docker.internal:host-gateway » au service (déjà présent dans compose.yaml)."
          : "host.docker.internal n'existe que dans les conteneurs Docker. Hors Docker, utilisez http://localhost:11434."
        : "Nom d'hôte introuvable. Utilisez une adresse IP ou un nom résolu par le DNS du serveur.";
    return new ProviderError(`Hôte « ${host} » introuvable.`, "unreachable", hint);
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new ProviderError(
      `Hôte ${host}:${port} injoignable.`,
      "unreachable",
      "Vérifiez l'adresse IP, que les deux machines sont sur le même réseau et qu'aucun pare-feu ne bloque le port.",
    );
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return new ProviderError("La connexion avec le serveur IA a été interrompue.", "unreachable", "Le moteur IA s'est peut-être arrêté ou a manqué de mémoire.");
  }
  if (code.startsWith("ERR_TLS") || code.includes("CERT")) {
    return new ProviderError("Erreur TLS avec le serveur IA.", "unreachable", "Certificat invalide ou serveur en http : vérifiez le schéma http/https.");
  }
  return new ProviderError(
    `Impossible de joindre le serveur IA (${e?.cause?.message ?? e?.message ?? "erreur inconnue"}).`,
    "unreachable",
  );
}
