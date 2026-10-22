import "server-only";
import type { AppSettings } from "@prisma/client";
import { errorDetails, logEvent } from "@/lib/logger";
import type { LlmProvider } from "@/lib/llm/types";
import { TtlCache } from "./cache";
import type { SearchDecision } from "./decide";
import { extractPage, extractPlain, normalizeDate, type ExtractedPage } from "./extract";
import { createSearchProvider, searchConfigFrom } from "./providers";
import { SearchError, type SearchProvider, type SearchResult } from "./providers/types";
import { buildQueryPrompt, parseQueries, QUERY_JSON_SCHEMA } from "./queries";
import { computeRagCharBudget, type RagSource } from "./rag-prompt";
import { selectPassages, type Doc } from "./rank";
import { hostOf, type ResearchEvent, type ResearchMode, type ResearchStep, type SourceDTO, type StepItem } from "./research-types";
import { FetchBlockedError, safeFetch, validatePublicUrl } from "./safe-fetch";
import { clip, fold, terms } from "./text";
import { canonicalKey, cleanUrl, siteKey } from "./url-canon";

// Orchestration déterministe côté serveur : requêtes → recherche → récupération → extraction →
// segmentation → sélection → contexte. Le modèle n'intervient que pour formuler les requêtes
// (sortie JSON validée, avec repli) : la navigation ne dépend jamais de ses capacités d'outils.

export type StoredSource = SourceDTO & { passages: string[] };

export type PipelineResult = {
  status: "done" | "failed" | "cancelled";
  queries: string[];
  steps: ResearchStep[];
  sources: StoredSource[];
  rag: RagSource[];
  limitations: string[];
  error: string | null;
  hint?: string;
};

type Emit = (event: ResearchEvent) => void;

const searchCache = new TtlCache<SearchResult[]>(200);
const pageCache = new TtlCache<{ page: ExtractedPage; finalUrl: string; truncated: boolean }>(300);

export function clearSearchCaches() {
  searchCache.clear();
  pageCache.clear();
}

const SKIP_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|gz|tar|rar|7z|exe|dmg|apk|iso|mp[34]|mov|avi|png|jpe?g|gif|webp|svg)(\?|$)/i;

class StepTracker {
  readonly steps: ResearchStep[] = [];
  private seq = 0;

  constructor(private readonly emit: Emit) {}

  set(step: ResearchStep) {
    const i = this.steps.findIndex((s) => s.id === step.id);
    if (i >= 0) this.steps[i] = step;
    else this.steps.push(step);
    this.emit({ type: "research_step", seq: this.seq++, step });
  }

  patch(id: string, patch: Partial<ResearchStep>) {
    const cur = this.steps.find((s) => s.id === id);
    if (cur) this.set({ ...cur, ...patch });
  }

  /** Clôt les étapes encore en cours (annulation, erreur) : aucun état « en cours » ne reste affiché. */
  closeRunning(detail: string) {
    for (const s of this.steps) {
      if (s.status === "running" || s.status === "pending") {
        this.set({ ...s, status: "failed", detail, items: s.items?.map((it) => (it.status === "running" || it.status === "pending" ? { ...it, status: "failed", note: detail } : it)) });
      }
    }
  }
}

/** Source primaire probable : le domaine correspond à une entité de la question, ou site institutionnel. */
export function isPrimarySource(url: string, question: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (/(^|\.)(gouv\.fr|gov|gov\.[a-z]{2}|europa\.eu|who\.int|un\.org|legifrance\.gouv\.fr|service-public\.fr)$/.test(host)) return true;
  const label = siteKey(host).split(".")[0].replace(/-/g, "");
  if (label.length < 3) return false;
  const q = fold(question).replace(/[^a-z0-9]+/g, "");
  if (q.includes(label)) return true;
  // docs.python.org pour « python », nextjs.org pour « next.js »
  return terms(question).some((t) => t.replace(/[^a-z0-9]/g, "") === label);
}

function interleave(lists: SearchResult[][]): SearchResult[] {
  const out: SearchResult[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

export async function runResearch(opts: {
  question: string;
  context: string | null;
  decision: Extract<SearchDecision, { search: true }>;
  settings: AppSettings;
  llm: LlmProvider;
  model: string;
  /** Valeur du paramètre think à envoyer pour les appels utilitaires (false ou undefined). */
  utilityThink: boolean | undefined;
  contextLength?: number;
  signal: AbortSignal;
  emit: Emit;
  userId?: string;
  now?: Date;
  /** Tests : moteur injecté. */
  searchProvider?: SearchProvider;
}): Promise<PipelineResult> {
  const { decision, settings, signal } = opts;
  const now = opts.now ?? new Date();
  const mode: ResearchMode = decision.mode;
  const tracker = new StepTracker(opts.emit);
  const limitations: string[] = [];
  let queries: string[] = [];
  const ttlMs = settings.searchCacheTtlSec * 1000;
  const deadline = Date.now() + settings.searchTimeoutMs;
  const remaining = () => Math.max(1500, deadline - Date.now());

  const result = (status: PipelineResult["status"], extra: Partial<PipelineResult> = {}): PipelineResult => ({
    status,
    queries,
    steps: tracker.steps,
    sources: [],
    rag: [],
    limitations,
    error: null,
    ...extra,
  });
  const cancelled = () => {
    tracker.closeRunning("Annulé");
    return result("cancelled", { error: "Recherche annulée." });
  };

  tracker.set({ id: "analyze", kind: "analyze", label: "Analyse de la question", status: "done", detail: decision.reason });

  // --- Moteur de recherche
  let search: SearchProvider;
  try {
    search = opts.searchProvider ?? createSearchProvider(searchConfigFrom(settings));
  } catch (err) {
    const e = err instanceof SearchError ? err : new SearchError("Moteur de recherche mal configuré.", "not_configured");
    tracker.set({ id: "search-0", kind: "search", label: "Recherche sur le Web", status: "failed", detail: e.message });
    limitations.push(`Recherche impossible : ${e.message}`);
    return result("failed", { error: e.message, hint: e.hint });
  }

  // --- Requêtes
  tracker.set({ id: "queries", kind: "queries", label: "Préparation des requêtes de recherche", status: "running" });
  let raw: string | null = null;
  try {
    raw = await opts.llm.completeJson(
      {
        model: opts.model,
        messages: buildQueryPrompt({ message: opts.question, context: opts.context, mode, timeSensitive: decision.timeSensitive, now }),
        think: opts.utilityThink,
        temperature: 0,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
      QUERY_JSON_SCHEMA as unknown as Record<string, unknown>,
    );
  } catch (err) {
    if (signal.aborted) return cancelled();
    await logEvent("INFO", "search:queries", "Formulation des requêtes par le modèle impossible, repli déterministe", errorDetails(err), opts.userId);
  }
  if (signal.aborted) return cancelled();
  const parsed = parseQueries(raw, opts.question, mode);
  queries = parsed.queries;
  tracker.patch("queries", {
    status: "done",
    count: queries.length,
    detail: `${queries.length} requête${queries.length > 1 ? "s" : ""}${parsed.fromModel ? "" : " (formulation automatique)"}`,
  });

  // --- Recherche (requêtes en parallèle, résultats mis en cache)
  const count = settings.searchMaxResults;
  const runQuery = async (q: string, i: number): Promise<SearchResult[]> => {
    const id = `search-${i}`;
    tracker.set({ id, kind: "search", label: i === 0 ? `Recherche : « ${q} »` : `Recherche complémentaire : « ${q} »`, status: "running" });
    const key = `${search.kind}|${q}|${decision.freshness ?? ""}`;
    const hit = searchCache.get(key, ttlMs);
    if (hit) {
      tracker.patch(id, { status: "done", count: hit.value.length, detail: `${hit.value.length} résultat(s) (déjà obtenus il y a ${Math.max(1, Math.round((Date.now() - hit.at) / 60_000))} min)` });
      return hit.value;
    }
    let results = await search.search(q, { signal, count, timeoutMs: Math.min(remaining(), 12_000), freshness: decision.freshness });
    // Filtre de fraîcheur trop strict : nouvel essai sans restriction de date.
    if (results.length === 0 && decision.freshness) results = await search.search(q, { signal, count, timeoutMs: Math.min(remaining(), 12_000) });
    searchCache.set(key, results);
    const via = results.find((r) => r.via);
    if (via) {
      // Secours utilisé : signalé dans l'étape et dans les limites de la recherche (une seule fois).
      const note = `${via.fallbackReason ?? "moteur principal indisponible"} : résultats fournis par Brave Search (secours).`;
      if (!limitations.includes(note)) limitations.push(note);
      tracker.patch(id, { status: "done", count: results.length, detail: `${results.length} résultat(s) via Brave Search (secours)` });
    } else {
      tracker.patch(id, { status: "done", count: results.length, detail: `${results.length} résultat(s)` });
    }
    return results;
  };
  const settled = await Promise.allSettled(queries.map((q, i) => runQuery(q, i)));
  if (signal.aborted) return cancelled();
  const lists: SearchResult[][] = [];
  let firstError: SearchError | null = null;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") lists.push(s.value);
    else {
      const e = s.reason instanceof SearchError ? s.reason : new SearchError("Erreur inattendue du moteur de recherche.", "bad_response");
      firstError ??= e;
      tracker.patch(`search-${i}`, { status: "failed", detail: e.message });
    }
  });
  if (lists.length === 0) {
    const e = firstError ?? new SearchError("Moteur de recherche indisponible.", "unreachable");
    limitations.push(`Moteur de recherche indisponible : ${e.message}`);
    await logEvent("WARN", "search", e.message, { code: e.code, provider: search.kind }, opts.userId);
    return result("failed", { error: e.message, hint: e.hint });
  }
  if (firstError) limitations.push(`Une des recherches a échoué : ${(firstError as SearchError).message}`);

  // --- Candidats : dédoublonnage des URL équivalentes, au plus 2 pages par site
  const seen = new Set<string>();
  const perSite = new Map<string, number>();
  const candidates: SearchResult[] = [];
  // Ordre du moteur, ajusté : sources primaires d'abord, et pour une question datée, résultats récents d'abord.
  const nowMs = now.getTime();
  const ordered = interleave(lists)
    .map((r, i) => {
      let rank = i;
      if (isPrimarySource(r.url, opts.question)) rank -= 3;
      const date = decision.timeSensitive ? normalizeDate(r.publishedAt, nowMs) : null;
      if (date) {
        const age = (nowMs - Date.parse(date)) / 86_400_000;
        rank -= age < 45 ? 4 : age < 365 ? 1 : -2;
      }
      return { r, rank };
    })
    .sort((x, y) => x.rank - y.rank)
    .map((x) => x.r);
  for (const r of ordered) {
    const v = validatePublicUrl(r.url);
    if (!v.ok || SKIP_EXT.test(v.url.pathname)) continue;
    const key = canonicalKey(r.url);
    if (seen.has(key)) continue;
    const site = siteKey(v.url.hostname);
    if ((perSite.get(site) ?? 0) >= 2) continue;
    seen.add(key);
    perSite.set(site, (perSite.get(site) ?? 0) + 1);
    candidates.push({ ...r, url: cleanUrl(r.url) });
    if (candidates.length >= count) break;
  }
  if (candidates.length === 0) {
    limitations.push("La recherche n'a renvoyé aucun résultat exploitable.");
    return result("done", { error: null });
  }

  // --- Consultation et extraction des pages (en parallèle, bornées en nombre, taille et durée)
  const maxPages = settings.searchMaxPages;
  const items: StepItem[] = candidates.slice(0, maxPages).map((c) => ({ url: c.url, title: clip(c.title || hostOf(c.url), 120), host: hostOf(c.url), status: "pending" }));
  tracker.set({ id: "fetch", kind: "fetch", label: "Consultation des pages", status: "running", items, detail: `${candidates.length} résultat(s) pertinent(s), ${Math.min(maxPages, candidates.length)} page(s) à consulter` });
  const setItem = (url: string, patch: Partial<StepItem>) => {
    const idx = items.findIndex((it) => it.url === url);
    if (idx >= 0) items[idx] = { ...items[idx], ...patch };
    tracker.patch("fetch", { items: [...items] });
  };

  type Fetched = { candidate: SearchResult; page: ExtractedPage | null; finalUrl: string; cached: boolean; truncated: boolean; failure?: string };
  const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining())]);
  const perPageTimeout = Math.min(9_000, Math.max(3_000, settings.searchTimeoutMs / 2));
  const fetchOne = async (c: SearchResult): Promise<Fetched> => {
    setItem(c.url, { status: "running" });
    const key = canonicalKey(c.url);
    const hit = pageCache.get(key, ttlMs);
    if (hit) {
      setItem(c.url, { status: "done", note: "Contenu déjà récupéré récemment (cache)" });
      return { candidate: c, page: hit.value.page, finalUrl: hit.value.finalUrl, cached: true, truncated: hit.value.truncated };
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await safeFetch(c.url, { signal: fetchSignal, timeoutMs: perPageTimeout });
        const page = res.contentType.includes("text/plain") ? extractPlain(res.body) : extractPage(res.body, res.finalUrl);
        pageCache.set(key, { page, finalUrl: res.finalUrl, truncated: res.truncated });
        const poor = page.textLength < 200;
        setItem(c.url, {
          status: poor ? "failed" : "done",
          title: clip(page.title || c.title || hostOf(c.url), 120),
          note: poor ? "Contenu textuel insuffisant (page dynamique ou protégée)" : `${Math.round(page.textLength / 100) / 10} k caractères extraits${res.truncated ? " (page tronquée)" : ""}`,
        });
        return { candidate: c, page: poor ? null : page, finalUrl: res.finalUrl, cached: false, truncated: res.truncated, failure: poor ? "contenu insuffisant" : undefined };
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof FetchBlockedError && (err.reason === "network" || (err.reason === "status" && /5\d\d/.test(err.message)));
        if (!retryable || fetchSignal.aborted || attempt === 1) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const msg = signal.aborted ? "Annulé" : lastErr instanceof FetchBlockedError ? lastErr.message : "Échec de la récupération";
    setItem(c.url, { status: "failed", note: msg });
    return { candidate: c, page: null, finalUrl: c.url, cached: false, truncated: false, failure: msg };
  };
  const fetched = await Promise.all(candidates.slice(0, maxPages).map(fetchOne));
  if (signal.aborted) return cancelled();
  const ok = fetched.filter((f) => f.page);
  const failed = fetched.filter((f) => !f.page);
  tracker.patch("fetch", {
    status: ok.length ? "done" : "failed",
    count: ok.length,
    detail: `${ok.length} page(s) lue(s)${failed.length ? `, ${failed.length} inaccessible(s)` : ""}`,
  });
  if (failed.length) limitations.push(`${failed.length} page(s) n'ont pas pu être lues ; seul leur extrait de recherche a pu être utilisé.`);

  // --- Documents : pages lues + extraits du moteur pour les pages inaccessibles (signalés comme tels)
  const accessedAt = now.toISOString();
  type DocMeta = { doc: Doc; source: Omit<StoredSource, "n" | "snippet" | "passages"> };
  const metas: DocMeta[] = [];
  const docSeen = new Set<string>();
  const addDoc = (f: Fetched | { candidate: SearchResult; page: null; finalUrl: string; cached: false; truncated: false }) => {
    const c = f.candidate;
    const page = f.page;
    // URL canonique déclarée par la page, retenue seulement si elle reste sur le même site.
    const canonical = page?.canonical && siteKey(hostOf(page.canonical)) === siteKey(hostOf(f.finalUrl)) && validatePublicUrl(page.canonical).ok ? page.canonical : null;
    const url = cleanUrl(canonical ?? f.finalUrl ?? c.url);
    const key = canonicalKey(url);
    if (docSeen.has(key)) return;
    docSeen.add(key);
    const blocks = page ? page.blocks : c.snippet.length >= 60 ? [{ heading: null, text: c.snippet }] : [];
    if (blocks.length === 0) return;
    const title = clip(page?.title || c.title || hostOf(url), 200);
    const publishedAt = page?.publishedAt ?? normalizeDate(c.publishedAt);
    const content = page ? (f.truncated ? "partial" : "full") : "snippet";
    metas.push({
      doc: { key, title, publishedAt, primary: isPrimarySource(url, opts.question), content, blocks },
      source: {
        url,
        title,
        host: hostOf(url),
        siteName: page?.siteName ? clip(page.siteName, 80) : null,
        favicon: page?.favicon ?? (url.startsWith("https:") ? `${new URL(url).origin}/favicon.ico` : null),
        publishedAt,
        accessedAt: f.cached ? accessedAt : accessedAt,
        content,
        primary: isPrimarySource(url, opts.question),
        cached: f.cached,
      },
    });
  };
  for (const f of fetched) addDoc(f);
  // Peu de pages lisibles : on complète avec les extraits des résultats non consultés.
  if (ok.length < 2) for (const c of candidates.slice(maxPages)) addDoc({ candidate: c, page: null, finalUrl: c.url, cached: false, truncated: false });

  // --- Sélection des passages
  tracker.set({ id: "select", kind: "select", label: "Sélection des passages pertinents", status: "running" });
  const budget = computeRagCharBudget(opts.contextLength, mode);
  const ranked = selectPassages(
    metas.map((m) => m.doc),
    [opts.question, ...queries].join(" "),
    { timeSensitive: decision.timeSensitive, maxSources: mode === "deep" ? 6 : 5, perSource: mode === "deep" ? 3 : 2, charBudget: budget, now: now.getTime() },
  );
  const byKey = new Map(metas.map((m) => [m.doc.key, m]));
  const sources: StoredSource[] = ranked.selected.map((sel, i) => {
    const m = byKey.get(sel.docKey)!;
    return { ...m.source, n: i + 1, snippet: clip(sel.passages[0]?.text ?? "", 280), passages: sel.passages.map((p) => p.text) };
  });
  const passageCount = ranked.selected.reduce((n, s) => n + s.passages.length, 0);
  tracker.patch("select", {
    status: sources.length ? "done" : "failed",
    count: sources.length,
    detail: sources.length
      ? `${passageCount} passage(s) retenu(s) sur ${ranked.chunkCount} segment(s) analysé(s) dans ${metas.length} document(s)${ranked.duplicates ? `, ${ranked.duplicates} doublon(s) écarté(s)` : ""}`
      : "Aucun passage ne correspond à la question.",
  });
  if (!sources.length) {
    limitations.push("Aucun passage des pages consultées ne répond directement à la question.");
    return result("done");
  }
  if (sources.every((s) => s.content === "snippet")) limitations.push("Aucune page n'a pu être lue en entier : la réponse repose uniquement sur des extraits de recherche.");
  if (decision.timeSensitive && !sources.some((s) => s.publishedAt)) limitations.push("Les dates de publication des sources n'ont pas pu être déterminées.");

  // --- Contexte documentaire
  const rag: RagSource[] = sources.map((s) => ({ n: s.n, title: s.title, host: s.host, url: s.url, publishedAt: s.publishedAt, passages: s.passages, content: s.content }));
  const chars = rag.reduce((n, s) => n + s.passages.join("").length, 0);
  tracker.set({
    id: "context",
    kind: "context",
    label: "Préparation du contexte documentaire",
    status: "done",
    count: sources.length,
    detail: `${sources.length} source(s), environ ${Math.round(chars / 100) / 10} k caractères transmis au modèle`,
  });
  opts.emit({ type: "research_sources", sources: sources.map(toSourceDTO) });
  return result("done", { sources, rag });
}

export function toSourceDTO(s: StoredSource): SourceDTO {
  const { passages: _p, ...dto } = s;
  void _p;
  return dto;
}
