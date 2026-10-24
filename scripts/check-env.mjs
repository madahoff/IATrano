#!/usr/bin/env node
// Contrôle des variables d'environnement de production d'IATrano (compose.yaml / Dokploy).
// N'affiche JAMAIS les valeurs secrètes : seulement le nom de la variable et le problème détecté.
//
//   node scripts/check-env.mjs .env            # fichier .env (ex. copie de l'onglet Environment de Dokploy)
//   node scripts/check-env.mjs                 # variables du processus courant
//
// Code de sortie : 0 si aucune erreur (avertissements possibles), 1 sinon.

import { readFileSync } from "node:fs";

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    out[m[1]] = value;
  }
  return out;
}

const file = process.argv[2];
let vars;
try {
  vars = file ? parseDotenv(readFileSync(file, "utf8")) : { ...process.env };
} catch (err) {
  console.error(`Lecture impossible de ${file} : ${err.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const get = (k) => (vars[k] ?? "").trim();
const has = (k) => get(k) !== "";
const PLACEHOLDER = /^(__.*|change[-_]?me.*|changeme|xxx+|todo|<.*>|\$\{.*\}|remplace.*|a-remplacer.*)$/i;

function required(name, why) {
  if (!has(name)) errors.push(`${name} : manquante ou vide — ${why}`);
  else if (PLACEHOLDER.test(get(name))) errors.push(`${name} : contient encore un placeholder — ${why}`);
}
function oneOf(name, values, fallback) {
  if (!has(name)) return fallback;
  const v = get(name);
  if (!values.includes(v)) errors.push(`${name} : valeur invalide (attendu : ${values.join(", ")})`);
  return v;
}
function intRange(name, min, max) {
  if (!has(name)) return;
  const n = Number(get(name));
  if (!Number.isFinite(n) || n < min || n > max) errors.push(`${name} : nombre attendu entre ${min} et ${max}`);
}
function url(name, { internalOk = true } = {}) {
  if (!has(name)) return null;
  let u;
  try {
    u = new URL(get(name));
  } catch {
    errors.push(`${name} : URL invalide (ex. http://hote:port)`);
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol)) errors.push(`${name} : seul http ou https est accepté`);
  if (u.username || u.password) errors.push(`${name} : ne mettez pas d'identifiants dans l'URL`);
  const host = u.hostname;
  if (host === "localhost" || host.startsWith("127.") || host === "[::1]") {
    errors.push(`${name} : « ${host} » désigne le conteneur lui-même ; utilisez host.docker.internal, le nom d'un service Docker ou l'IP de la machine`);
  }
  if (!internalOk && u.protocol === "http:") warnings.push(`${name} : liaison non chiffrée (http)`);
  return u;
}

// --- Base de données
required("POSTGRES_PASSWORD", "mot de passe PostgreSQL (openssl rand -hex 24)");
if (has("POSTGRES_PASSWORD")) {
  const p = get("POSTGRES_PASSWORD");
  if (!/^[A-Za-z0-9]+$/.test(p)) errors.push("POSTGRES_PASSWORD : lettres et chiffres uniquement (il est inséré tel quel dans DATABASE_URL)");
  if (p.length < 16) errors.push("POSTGRES_PASSWORD : 16 caractères minimum");
  if (["iatrano", "postgres", "password"].includes(p)) errors.push("POSTGRES_PASSWORD : valeur de développement, interdite en production");
}
for (const k of ["POSTGRES_USER", "POSTGRES_DB"]) {
  if (has(k) && !/^[a-z_][a-z0-9_]{0,62}$/.test(get(k))) errors.push(`${k} : minuscules, chiffres et _ uniquement`);
}
if (has("DATABASE_URL")) warnings.push("DATABASE_URL : ignorée par compose.yaml (construite à partir de POSTGRES_*) ; retirez-la pour éviter toute confusion");

// --- Sécurité et comptes
required("AUTH_SECRET", "secret des sessions et du chiffrement des clés en base (openssl rand -base64 48)");
if (has("AUTH_SECRET") && get("AUTH_SECRET").length < 32) errors.push("AUTH_SECRET : 32 caractères minimum (l'application refuse de démarrer sinon)");
if (has("AUTH_SECRET") && get("AUTH_SECRET").startsWith("dev-insecure-secret")) errors.push("AUTH_SECRET : secret de développement");
required("SUPERADMIN_EMAIL", "e-mail du premier super-administrateur");
if (has("SUPERADMIN_EMAIL") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get("SUPERADMIN_EMAIL"))) errors.push("SUPERADMIN_EMAIL : adresse e-mail invalide");
if (get("SUPERADMIN_EMAIL").toLowerCase() === "admin@example.com") warnings.push("SUPERADMIN_EMAIL : adresse d'exemple");
required("SUPERADMIN_PASSWORD", "mot de passe initial du super-administrateur (12 caractères minimum)");
if (has("SUPERADMIN_PASSWORD") && get("SUPERADMIN_PASSWORD").length < 12) errors.push("SUPERADMIN_PASSWORD : 12 caractères minimum (sinon aucun compte n'est créé)");
const cookie = oneOf("COOKIE_SECURE", ["auto", "true", "false", "1", "0"], "auto");
if (cookie === "false" || cookie === "0") warnings.push("COOKIE_SECURE=false : cookie de session envoyé aussi en http ; à réserver à un accès local sans HTTPS");
oneOf("TRUST_PROXY", ["true", "false", "1", "0", "auto"], "true");
intRange("RATE_LIMIT_GENERATIONS_PER_MINUTE", 1, 10_000);

// --- Serveur IA
oneOf("AI_PROVIDER", ["ollama", "openai"], "ollama");
if (!has("AI_BASE_URL")) warnings.push("AI_BASE_URL : absente, valeur par défaut http://host.docker.internal:11434 (Ollama doit écouter sur 0.0.0.0)");
url("AI_BASE_URL");

// --- Recherche Web
const provider = oneOf("SEARCH_PROVIDER", ["searxng", "brave"], "searxng");
required("SEARXNG_SECRET", "secret interne de SearXNG (openssl rand -hex 32)");
if (has("SEARXNG_SECRET") && get("SEARXNG_SECRET").length < 32) errors.push("SEARXNG_SECRET : 32 caractères minimum");
if (has("SEARXNG_URL")) url("SEARXNG_URL");
if (provider === "brave" && !has("BRAVE_SEARCH_API_KEY")) errors.push("BRAVE_SEARCH_API_KEY : obligatoire quand SEARCH_PROVIDER=brave");
if (has("SEARXNG_IMAGE") && /:latest$|^[^:]+$/.test(get("SEARXNG_IMAGE"))) warnings.push("SEARXNG_IMAGE : version non épinglée (latest) ; déploiements non reproductibles");

// --- JEV
if (has("JEV_HOST") && /^(localhost|127\.)/.test(get("JEV_HOST"))) errors.push("JEV_HOST : localhost désigne le conteneur ; utilisez host.docker.internal ou l'IP du serveur JEV");
intRange("JEV_PORT", 1, 65535);
oneOf("JEV_PROTOCOL", ["http", "https"], "http");
intRange("JEV_TIMEOUT_SEC", 1, 300);
if (!has("JEV_API_KEY")) warnings.push("JEV_API_KEY : vide ; le serveur JEV actuel exige une clé (sinon pas de routage JEV) — renseignez-la ici ou dans Administration → Connexion JEV");

// --- Documents
if (has("DOCUMENT_TRANSCRIPTION_URL")) url("DOCUMENT_TRANSCRIPTION_URL");
if (has("DOCUMENT_WORKER") && !["off", ""].includes(get("DOCUMENT_WORKER"))) errors.push("DOCUMENT_WORKER : seule la valeur « off » est reconnue (vide = file active)");
if (has("DOCUMENT_STORAGE_DIR")) warnings.push("DOCUMENT_STORAGE_DIR : fixée par l'image (/app/data/documents, volume iatrano-documents) ; ne la redéfinissez pas");

// --- Ressources et build
for (const k of ["APP_MEMORY_LIMIT", "DB_MEMORY_LIMIT"]) {
  if (has(k) && !/^\d+(\.\d+)?[kmg]$/i.test(get(k))) errors.push(`${k} : format attendu 512m, 4g…`);
}
if (has("APP_CPU_LIMIT") && !(Number(get("APP_CPU_LIMIT")) > 0)) errors.push("APP_CPU_LIMIT : nombre de cœurs attendu (ex. 4)");
for (const k of ["WITH_FFMPEG", "WITH_TESSERACT"]) oneOf(k, ["true", "false"], "true");

// --- Variables inconnues (fautes de frappe)
const KNOWN = new Set([
  "POSTGRES_PASSWORD", "POSTGRES_USER", "POSTGRES_DB", "DATABASE_URL", "AUTH_SECRET", "SUPERADMIN_EMAIL", "SUPERADMIN_PASSWORD",
  "SUPERADMIN_NAME", "COOKIE_SECURE", "TRUST_PROXY", "RATE_LIMIT_GENERATIONS_PER_MINUTE", "AI_PROVIDER", "AI_BASE_URL", "AI_API_KEY",
  "AI_URL_ALLOWLIST", "SEARCH_PROVIDER", "SEARXNG_URL", "SEARXNG_SECRET", "SEARXNG_IMAGE", "BRAVE_SEARCH_API_KEY", "JEV_HOST", "JEV_PORT",
  "JEV_PROTOCOL", "JEV_API_KEY", "JEV_TIMEOUT_SEC", "DOCUMENT_STORAGE_DIR", "DOCUMENT_EMBEDDING_MODEL", "DOCUMENT_TRANSCRIPTION_URL",
  "DOCUMENT_TRANSCRIPTION_MODEL", "DOCUMENT_VISION_MODEL", "DOCUMENT_WORKER", "NODE_VERSION", "WITH_FFMPEG", "WITH_TESSERACT",
  "NODE_OPTIONS", "APP_MEMORY_LIMIT", "APP_CPU_LIMIT", "DB_MEMORY_LIMIT", "APP_PORT", "APP_BIND",
]);
if (file) {
  for (const k of Object.keys(vars)) if (!KNOWN.has(k)) warnings.push(`${k} : variable inconnue d'IATrano (faute de frappe ?)`);
}

for (const w of warnings) console.log(`  avertissement  ${w}`);
for (const e of errors) console.log(`  ERREUR         ${e}`);
if (errors.length) {
  console.log(`\n${errors.length} erreur(s), ${warnings.length} avertissement(s) : configuration NON valide.`);
  process.exit(1);
}
console.log(`\nConfiguration valide (${warnings.length} avertissement(s)).`);
