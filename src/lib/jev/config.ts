import { z } from "zod";

// Validation de la configuration de connexion à JEV, partagée entre le formulaire et les routes API.

export type JevProtocol = "HTTP" | "HTTPS";

export const JEV_FACTORY_DEFAULTS = {
  host: "100.121.17.90",
  port: 8017,
  protocol: "HTTP" as JevProtocol,
  timeoutSec: 10,
  defaultThreshold: 0.5,
};

// Services de métadonnées des hébergeurs : jamais joignables depuis l'administration.
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "100.100.100.200", "fd00:ec2::254"]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV6 = /^[0-9a-f:.]+$/i;

/** Renvoie un message d'erreur en français, ou null si l'hôte est valide (IPv4, IPv6 ou nom d'hôte). */
export function hostError(input: string): string | null {
  const host = input.trim().replace(/^\[|\]$/g, "");
  if (!host) return "L'hôte est obligatoire.";
  if (/^[a-z]+:\/\//i.test(host)) return "Saisissez uniquement l'hôte, sans http:// (le protocole se choisit à part).";
  if (/^[^:]+:\d+$/.test(host)) return "Saisissez le port dans le champ « Port », pas dans l'hôte.";
  if (/[/@?#\s]/.test(host)) return "Saisissez uniquement l'hôte (sans chemin, identifiant ni espace).";
  if (BLOCKED_HOSTS.has(host.toLowerCase())) return "Cette adresse (service de métadonnées) est interdite.";
  const v4 = host.match(IPV4);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? null : "Adresse IPv4 invalide (chaque nombre doit être compris entre 0 et 255).";
  if (/^[\d.]+$/.test(host)) return "Adresse IPv4 invalide (format attendu : 100.121.17.90).";
  if (host.includes(":")) return IPV6.test(host) && host.split(":").length >= 3 ? null : "Adresse IPv6 invalide.";
  return HOSTNAME.test(host) ? null : "Nom d'hôte invalide (lettres, chiffres, tirets et points uniquement).";
}

export const jevConnectionSchema = z.object({
  host: z
    .string()
    .trim()
    .max(253)
    .superRefine((v, ctx) => {
      const e = hostError(v);
      if (e) ctx.addIssue({ code: "custom", message: e });
    }),
  port: z.number({ message: "Le port doit être un nombre." }).int("Le port doit être un entier.").min(1, "Le port doit être compris entre 1 et 65535.").max(65535, "Le port doit être compris entre 1 et 65535."),
  protocol: z.enum(["HTTP", "HTTPS"]),
  timeoutSec: z.number({ message: "Le délai doit être un nombre." }).gt(0, "Le délai doit être supérieur à 0.").max(300, "Le délai ne peut pas dépasser 300 s."),
  defaultThreshold: z.number({ message: "Le seuil doit être un nombre." }).min(0, "Le seuil doit être compris entre 0 et 1.").max(1, "Le seuil doit être compris entre 0 et 1."),
});

export type JevConnectionInput = z.infer<typeof jevConnectionSchema>;

export function jevBaseUrl(c: { protocol: JevProtocol; host: string; port: number }): string {
  const host = c.host.trim().replace(/^\[|\]$/g, "");
  return `${c.protocol === "HTTPS" ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${c.port}`;
}
