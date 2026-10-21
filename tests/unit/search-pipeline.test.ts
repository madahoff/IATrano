// Décision de recherche, requêtes, extraction, segmentation et sélection des passages.
import { describe, expect, it } from "vitest";
import { decideSearch } from "@/lib/search/decide";
import { fallbackQuery, parseQueries, redactQuery } from "@/lib/search/queries";
import { extractPage, normalizeDate } from "@/lib/search/extract";
import { chunkDoc, selectPassages, type Doc } from "@/lib/search/rank";
import { canonicalKey, siteKey } from "@/lib/search/url-canon";
import { computeRagCharBudget } from "@/lib/search/rag-prompt";

const now = new Date("2026-10-21T12:00:00Z");

describe("decideSearch", () => {
  it.each([
    "Quelles sont les actualités de l'IA aujourd'hui ?",
    "Quelle est la dernière version de Next.js ?",
    "Quel est le prix actuel du Bitcoin ?",
    "Qui a gagné le match hier soir ?",
    "Quoi de neuf dans React 20 sorti en 2026 ?",
    "Que dit la documentation officielle de Prisma sur les migrations ?",
  ])("recherche automatiquement : %s", (q) => {
    const d = decideSearch(q, { now });
    expect(d.search).toBe(true);
  });
  it.each([
    "Bonjour !",
    "Merci",
    "Combien font 17 fois 23 ?",
    "12 * 7",
    "Écris un poème sur la mer",
    "Traduis « bonjour » en anglais",
    "Écris une fonction Python qui trie une liste",
    "Explique le théorème de Pythagore",
    "Qu'est-ce qu'une boucle for ?",
  ])("répond sans recherche : %s", (q) => {
    expect(decideSearch(q, { now }).search).toBe(false);
  });
  it.each([
    "Cherche sur internet ce qu'est la photosynthèse",
    "Peux-tu vérifier sur le web la définition de l'entropie ?",
    "Explique le théorème de Pythagore avec des sources",
    "Search the web for the boiling point of water",
  ])("recherche explicite même si non nécessaire : %s", (q) => {
    const d = decideSearch(q, { now });
    expect(d.search).toBe(true);
    if (d.search) expect(["explicit", "deep"]).toContain(d.mode);
  });
  it("recherche approfondie pour une comparaison documentée", () => {
    const d = decideSearch("Compare les prix actuels de Vercel et Netlify", { now });
    expect(d.search && d.mode).toBe("deep");
  });
  it("ignore un long texte fourni à transformer et le code collé", () => {
    expect(decideSearch("Corrige ce code :\n```js\nconst prix = 2026;\n```", { now }).search).toBe(false);
  });
  it("poursuit la recherche pour une question de suivi courte", () => {
    expect(decideSearch("Et pour la version précédente ?", { now, previousUsedSearch: true }).search).toBe(true);
    expect(decideSearch("Et pour la version précédente ?", { now, previousUsedSearch: false }).search).toBe(true); // « version » est volatile
    expect(decideSearch("Et toi, tu en penses quoi ?", { now, previousUsedSearch: false }).search).toBe(false);
  });
});

describe("Requêtes de recherche", () => {
  it("retire les données personnelles et secrets", () => {
    const q = redactQuery("contrat de jean.dupont@mail.fr tel +33 6 12 34 56 78 clé sk-abcdefghijklmnopqrstuvwx mot de passe: hunter2 en 2026");
    expect(q).not.toMatch(/@|12 34|sk-|hunter2/);
    expect(q).toContain("2026");
  });
  it("produit une requête de repli sans formules de politesse", () => {
    expect(fallbackQuery("Peux-tu chercher sur internet la dernière version de Next.js stp ?")).toBe("la dernière version de Next.js");
  });
  it("valide la sortie du modèle et se replie si elle est invalide", () => {
    expect(parseQueries('{"queries":["Next.js 16 release notes","Next.js latest version"]}', "dernière version de Next.js", "auto")).toEqual({
      queries: ["Next.js 16 release notes", "Next.js latest version"],
      fromModel: true,
    });
    const bad = parseQueries("pas du json", "dernière version de Next.js", "auto");
    expect(bad).toEqual({ queries: ["dernière version de Next.js"], fromModel: false });
    expect(parseQueries('{"q": 1}', "x y z", "deep").fromModel).toBe(false);
    expect(parseQueries('{"queries":["a","b","c","d","e"]}', "question test", "deep").queries.length).toBeLessThanOrEqual(3);
  });
});

describe("Extraction HTML", () => {
  const html = `<!doctype html><html lang="fr"><head>
    <title>Titre onglet</title>
    <meta property="og:title" content="Next.js 16.4 est disponible">
    <meta property="og:site_name" content="Next.js Blog">
    <meta property="article:published_time" content="2026-10-06T20:00:00Z">
    <link rel="canonical" href="https://nextjs.org/blog/next-16-4">
    <link rel="icon" href="https://cdn.tiers.example/logo.png">
    <link rel="icon" href="/favicon-32.png">
    </head><body><header><a href="/">Accueil</a></header>
    <main><h2>Nouveautés</h2><p>La version 16.4 apporte Turbopack pour les builds de production et améliore le cache.</p>
    <ul class="share-buttons"><li><a href="#">Partager sur un réseau social quelconque</a></li></ul>
    <p>Les Server Actions sont désormais plus rapides grâce à une nouvelle sérialisation.</p></main></body></html>`;
  const page = extractPage(html, "https://nextjs.org/blog/next-16-4?utm_source=x");

  it("lit les métadonnées réelles de la page", () => {
    expect(page.title).toBe("Next.js 16.4 est disponible");
    expect(page.siteName).toBe("Next.js Blog");
    expect(page.canonical).toBe("https://nextjs.org/blog/next-16-4");
    expect(page.publishedAt).toBe("2026-10-06T20:00:00.000Z");
    expect(page.lang).toBe("fr");
  });
  it("n'utilise jamais l'icône d'un autre domaine", () => {
    expect(page.favicon).toBe("https://nextjs.org/favicon-32.png");
  });
  it("conserve les titres de section comme contexte des blocs", () => {
    expect(page.blocks[0]).toEqual({ heading: "Nouveautés", text: expect.stringContaining("Turbopack") });
    expect(page.blocks.map((b) => b.text).join(" ")).not.toContain("Partager");
  });
  it("ne fabrique aucune date", () => {
    expect(extractPage("<html><body><p>Texte sans date mais assez long pour être retenu par l'extracteur.</p></body></html>", "https://ex.com/").publishedAt).toBeNull();
    expect(normalizeDate("n'importe quoi")).toBeNull();
    expect(normalizeDate("2099-01-01")).toBeNull();
  });
});

describe("Segmentation et sélection", () => {
  const long = Array.from({ length: 30 }, (_, i) => `Phrase numéro ${i} qui parle de sujets variés comme la cuisine et le jardinage.`).join(" ");
  const docs: Doc[] = [
    {
      key: "a",
      title: "Notes de version Next.js 16.4",
      publishedAt: "2026-10-06T00:00:00Z",
      primary: true,
      content: "full",
      blocks: [
        { heading: "Nouveautés", text: "Next.js 16.4 apporte Turbopack en production et un nouveau cache. La version 16.4 est sortie en octobre 2026." },
        { heading: "Divers", text: long },
      ],
    },
    { key: "b", title: "Recette de cuisine", publishedAt: null, primary: false, content: "full", blocks: [{ heading: null, text: long }] },
    {
      key: "c",
      title: "Copie du blog",
      publishedAt: "2026-10-07T00:00:00Z",
      primary: false,
      content: "full",
      blocks: [{ heading: "Nouveautés", text: "Next.js 16.4 apporte Turbopack en production et un nouveau cache. La version 16.4 est sortie en octobre 2026." }],
    },
  ];

  it("découpe en segments bornés en conservant la provenance", () => {
    const chunks = chunkDoc(docs[0]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.docKey).toBe("a");
      expect(c.text.length).toBeLessThanOrEqual(1100 + 200);
    }
  });
  it("classe les passages pertinents, écarte les doublons et respecte le budget", () => {
    const r = selectPassages(docs, "dernière version Next.js 16.4 nouveautés", { timeSensitive: true, maxSources: 5, perSource: 2, charBudget: 3000, now: now.getTime() });
    expect(r.selected[0].docKey).toBe("a");
    expect(r.selected.some((s) => s.docKey === "c")).toBe(false);
    expect(r.duplicates).toBeGreaterThanOrEqual(1);
    const total = r.selected.flatMap((s) => s.passages).reduce((n, p) => n + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(3000);
  });
  it("ne retient rien quand aucun passage ne correspond", () => {
    expect(selectPassages(docs, "astrophysique quasar", { timeSensitive: false, maxSources: 5, perSource: 2, charBudget: 3000 }).selected).toEqual([]);
  });
  it("budget documentaire prudent pour un petit contexte", () => {
    expect(computeRagCharBudget(undefined, "auto")).toBeLessThanOrEqual(5100);
    expect(computeRagCharBudget(32768, "deep")).toBe(10_000);
  });
});

describe("URL équivalentes", () => {
  it("détecte les doublons (www, suivi, barre finale, ancre, AMP)", () => {
    const a = canonicalKey("https://www.example.com/article/?utm_source=x&id=2#top");
    expect(canonicalKey("https://example.com/article?id=2&fbclid=abc")).toBe(a);
    expect(canonicalKey("https://example.com/article/amp")).toBe(canonicalKey("https://example.com/article"));
    expect(canonicalKey("https://example.com/a")).not.toBe(canonicalKey("https://example.com/b"));
  });
  it("calcule le domaine enregistrable", () => {
    expect(siteKey("docs.python.org")).toBe("python.org");
    expect(siteKey("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteKey("service-public.gouv.fr")).toBe("service-public.gouv.fr");
  });
});

describe("Extraction : sites réels", () => {
  it("ne prend pas une classe utilitaire Tailwind pour un bloc de commentaires", () => {
    const body = Array.from({ length: 6 }, (_, i) => `<p>Paragraphe ${i} de l'article sur la version 16.4 qui contient suffisamment de texte rédigé pour compter.</p>`).join("");
    const html = `<html><body><div class="w-full [&_[data-next-issue-reopen-comment-header]_p]:text-label-13! contents">${body}</div><div class="comments">Un commentaire court mais assez long pour être un bloc.</div></body></html>`;
    const page = extractPage(html, "https://nextjs.org/blog/next-16-4");
    expect(page.blocks.length).toBe(6);
    expect(page.blocks.map((b) => b.text).join(" ")).not.toContain("commentaire");
  });
});
