import "server-only";
import { parse, type HTMLElement } from "node-html-parser";

// Extraction du contenu utile d'une page HTML (non fiable) : texte principal découpé en blocs,
// sans menus, publicités, scripts ni formulaires, et métadonnées RÉELLEMENT présentes dans la page.
// Aucune métadonnée n'est inventée : un champ introuvable reste null.

export type ExtractedPage = {
  title: string | null;
  siteName: string | null;
  canonical: string | null;
  favicon: string | null;
  publishedAt: string | null;
  lang: string | null;
  blocks: Array<{ heading: string | null; text: string }>;
  textLength: number;
};

const NOISE_TAGS = "script,style,noscript,template,svg,canvas,iframe,object,embed,form,button,select,input,textarea,nav,header,footer,aside,menu,dialog,figure>img,picture,video,audio,map";
const NOISE_ROLES = '[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"],[role="dialog"],[role="alert"],[aria-hidden="true"],[hidden]';
const NOISE_NAME = /(^|[\s_-])(nav|navbar|menu|breadcrumbs?|footer|header|sidebar|side-bar|cookie|consent|gdpr|banner|advert|ads?|adsbygoogle|sponsor|promo|newsletter|subscribe|signup|social|share|sharing|comments?|related|recommend|popular|trending|outbrain|taboola|modal|popup|skip-link|toolbar|pagination|pager)([\s_-]|$)/i;
const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th,dt,dd,figcaption,summary";

function meta(root: HTMLElement, ...keys: string[]): string | null {
  for (const key of keys) {
    const el = root.querySelector(`meta[property="${key}"]`) ?? root.querySelector(`meta[name="${key}"]`) ?? root.querySelector(`meta[itemprop="${key}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return null;
}

function absolute(href: string | undefined | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Date plausible (1995 → demain), normalisée en ISO ; sinon null. */
export function normalizeDate(raw: string | null | undefined, now = Date.now()): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return null;
  if (t < Date.UTC(1995, 0, 1) || t > now + 86_400_000) return null;
  return new Date(t).toISOString();
}

function findJsonLdDate(root: HTMLElement): string | null {
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.rawText) as unknown;
      const stack: unknown[] = [data];
      while (stack.length) {
        const cur = stack.pop();
        if (Array.isArray(cur)) stack.push(...cur);
        else if (cur && typeof cur === "object") {
          const o = cur as Record<string, unknown>;
          if (typeof o.datePublished === "string") return o.datePublished;
          if (o["@graph"]) stack.push(o["@graph"]);
        }
      }
    } catch {
      // JSON-LD invalide : ignoré
    }
  }
  return null;
}

/** Icône déclarée par la page, retenue seulement si elle est servie par le même site (pas de logo d'un tiers). */
function pickFavicon(root: HTMLElement, pageUrl: string): string | null {
  const page = new URL(pageUrl);
  const pageHost = page.hostname.replace(/^www\./, "");
  const candidates = root
    .querySelectorAll("link[rel]")
    .filter((l) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.getAttribute("rel") ?? ""))
    .map((l) => absolute(l.getAttribute("href"), pageUrl))
    .filter((u): u is string => Boolean(u) && u!.startsWith("https:"));
  for (const c of candidates) {
    const h = new URL(c).hostname.replace(/^www\./, "");
    if (h === pageHost || h.endsWith(`.${pageHost}`) || pageHost.endsWith(`.${h}`)) return c;
  }
  return page.protocol === "https:" ? `${page.origin}/favicon.ico` : null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function linkDensity(el: HTMLElement, textLength: number): number {
  if (!textLength) return 1;
  let linked = 0;
  for (const a of el.querySelectorAll("a")) linked += clean(a.text).length;
  return linked / textLength;
}

function isNoise(el: HTMLElement): boolean {
  // Classe par classe ; les utilitaires CSS (Tailwind « [&_x]:y », « md:… ») ne décrivent pas le rôle du bloc.
  const tokens = `${el.getAttribute("class") ?? ""} ${el.id ?? ""}`.split(/\s+/).filter((t) => t && !/[[\]:&(){}@!]/.test(t));
  if (!tokens.some((t) => NOISE_NAME.test(t))) return false;
  // Un bloc qui contient le contenu principal (article, main) ou beaucoup de texte rédigé n'est jamais retiré.
  if (el.querySelector("article,main")) return false;
  const len = clean(el.text).length;
  return len < 1500 || linkDensity(el, len) > 0.5;
}

function pickRoot(root: HTMLElement): HTMLElement {
  const body = root.querySelector("body") ?? root;
  const candidates = [
    ...body.querySelectorAll("article"),
    ...body.querySelectorAll('main,[role="main"],#content,#main,.post-content,.entry-content,.article-body,.markdown-body,.content'),
  ];
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    const len = clean(c.text).length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  // Un conteneur trop court (simple encart) ne remplace pas le corps de la page.
  return best && bestLen > 400 ? best : body;
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: false, noscript: false, pre: true } });
  const title = clean(meta(root, "og:title", "twitter:title") ?? root.querySelector("title")?.text ?? "") || null;
  const siteName = clean(meta(root, "og:site_name", "application-name") ?? "") || null;
  const canonicalHref = root.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const canonical = absolute(canonicalHref, pageUrl);
  const publishedAt = normalizeDate(
    meta(root, "article:published_time", "og:published_time", "datePublished", "date", "pubdate", "publish-date", "dc.date", "DC.date.issued") ??
      findJsonLdDate(root) ??
      root.querySelector("article time[datetime]")?.getAttribute("datetime"),
  );
  const lang = root.querySelector("html")?.getAttribute("lang")?.slice(0, 10) ?? null;
  const favicon = pickFavicon(root, pageUrl);

  for (const el of root.querySelectorAll(NOISE_TAGS)) el.remove();
  for (const el of root.querySelectorAll(NOISE_ROLES)) el.remove();
  for (const el of root.querySelectorAll("div,section,ul,ol,span,p,li,table")) if (isNoise(el)) el.remove();

  const main = pickRoot(root);
  const blocks: ExtractedPage["blocks"] = [];
  let heading: string | null = null;
  const seen = new Set<string>();
  const all = main.querySelectorAll(BLOCK_SELECTOR);
  const inMain = new Set(all);
  for (const el of all) {
    // Bloc imbriqué dans un autre bloc (ex. <p> dans <li>) : son texte est déjà pris par le parent.
    const parentBlock = el.parentNode?.closest(BLOCK_SELECTOR);
    if (parentBlock && inMain.has(parentBlock)) continue;
    const tag = el.tagName.toLowerCase();
    const text = clean(el.text);
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) {
      heading = text.slice(0, 200);
      continue;
    }
    if (text.length < 30 && tag !== "pre" && tag !== "td" && tag !== "dd") continue;
    if (text.length < 240 && linkDensity(el, text.length) > 0.6) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    blocks.push({ heading, text: tag === "pre" ? el.text.trim().slice(0, 4000) : text });
  }
  // Pages sans balisage sémantique (texte dans des <div>) : repli sur le texte structuré.
  if (blocks.reduce((n, b) => n + b.text.length, 0) < 300) {
    for (const line of main.structuredText.split("\n")) {
      const text = clean(line);
      if (text.length >= 40 && !seen.has(text)) {
        seen.add(text);
        blocks.push({ heading: null, text });
      }
    }
  }
  return { title, siteName, canonical, favicon, publishedAt, lang, blocks, textLength: blocks.reduce((n, b) => n + b.text.length, 0) };
}

/** Texte brut (text/plain) découpé en paragraphes. */
export function extractPlain(text: string): ExtractedPage {
  const blocks = text
    .split(/\n\s*\n/)
    .map((p) => clean(p))
    .filter((p) => p.length >= 30)
    .map((t) => ({ heading: null, text: t }));
  return { title: null, siteName: null, canonical: null, favicon: null, publishedAt: null, lang: null, blocks, textLength: blocks.reduce((n, b) => n + b.text.length, 0) };
}
