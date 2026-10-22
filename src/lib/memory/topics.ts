// Sujets stables des souvenirs. Deux préférences ou décisions actives du même sujet et de la même portée
// se contredisent (« préfère npm » puis « préfère pnpm ») : la plus récente remplace l'autre.
// Le dictionnaire couvre les choix techniques courants ; le modèle peut proposer d'autres sujets.

const CATEGORIES: Record<string, string[]> = {
  "gestionnaire-paquets": ["npm", "pnpm", "yarn", "bun", "pip", "poetry", "uv", "conda"],
  "langage-programmation": ["python", "javascript", "typescript", "java", "golang", "rust", "php", "ruby", "c#", "csharp", "kotlin", "swift", "dart", "elixir"],
  "framework-front": ["react", "vue", "vue.js", "angular", "svelte", "sveltekit", "next.js", "nextjs", "nuxt", "solid", "remix", "astro"],
  "framework-back": ["express", "fastify", "nestjs", "django", "flask", "fastapi", "laravel", "symfony", "rails", "spring"],
  "base-de-donnees": ["postgresql", "postgres", "mysql", "mariadb", "mongodb", "sqlite", "sql server", "oracle", "supabase"],
  "orm": ["prisma", "drizzle", "typeorm", "sequelize", "sqlalchemy", "eloquent"],
  "deploiement": ["dokploy", "kubernetes", "vercel", "netlify", "coolify", "heroku", "railway", "render", "caprover"],
  "editeur": ["vscode", "vs code", "vim", "neovim", "emacs", "webstorm", "intellij", "cursor", "zed", "sublime"],
  "style-css": ["tailwind", "tailwindcss", "bootstrap", "sass", "scss", "styled-components", "css modules"],
  "systeme": ["linux", "windows", "macos", "ubuntu", "debian", "fedora", "arch"],
  "tests": ["vitest", "jest", "mocha", "playwright", "cypress", "pytest"],
};

const LANGUAGES: Record<string, string> = {
  francais: "français",
  français: "français",
  anglais: "anglais",
  english: "anglais",
  malgache: "malgache",
  espagnol: "espagnol",
  allemand: "allemand",
  italien: "italien",
  portugais: "portugais",
};

export const RESPONSE_LANGUAGE_TOPIC = "langue-reponse";
export const ADDRESS_TOPIC = "registre-tutoiement";
export const NAME_TOPIC = "prenom";

/** Langue normalisée (« Anglais » → « anglais »), ou null. */
export function responseLanguage(word: string): string | null {
  return LANGUAGES[word.toLowerCase()] ?? null;
}

function hasTerm(text: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9#+.])${escaped}(?=$|[^a-z0-9#+])`, "i").test(text);
}

/** Catégorie technique unique évoquée par le texte (null si aucune ou plusieurs). */
export function topicFor(...texts: string[]): string | null {
  const text = texts.join(" ").toLowerCase();
  const found = Object.entries(CATEGORIES)
    .filter(([, terms]) => terms.some((t) => hasTerm(text, t)))
    .map(([key]) => key);
  return found.length === 1 ? found[0] : null;
}

/** Sujet proposé par le modèle → identifiant court et stable (« Gestionnaire de paquets » → « gestionnaire-de-paquets »). */
export function normalizeTopic(topic: string | null | undefined): string | null {
  const t = topic
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return t && t.length >= 3 ? t : null;
}
