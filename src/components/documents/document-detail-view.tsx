"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Download, ExternalLink, Loader2, MessageSquare, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageShell, Panel, Section } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import type { DocumentListItem } from "@/lib/documents/service";
import type { DocumentKindName, InsightSource, MethodContent } from "@/lib/documents/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { KindIcon, ProgressBar, statusLine } from "./document-library";
import { DocumentSearch } from "./document-search";
import { formatBytes, formatMs, KIND_LABELS, locationLabel, originalHref, overallProgress, PROGRESS_KEY, STAGE_LABELS, STAGE_ORDER, UNIT_LABELS } from "./format";
import { PageViewer } from "./page-viewer";

type Insight = { id: string; kind: string; title: string; content: unknown; text: string; origin: "EXPLICIT" | "INFERRED"; sources: InsightSource[]; status: string; version: number; model: string | null; createdAt: string };
type SectionRow = { id: string; ordinal: number; level: number; title: string; path: string[]; pageStart: number | null; pageEnd: number | null; startMs: number | null; endMs: number | null; tokenCount: number; analysisStatus: string; analysis: { subject?: string; summary?: string } | null };
type Detail = {
  document: DocumentListItem & { metadata: Record<string, unknown> | null; language: string | null };
  sections: SectionRow[];
  insights: Insight[];
  pageStats: Array<{ status: string; method: string; count: number }>;
  issues: Array<{ number: number; label: string | null; status: string; method: string; error: string | null; confidence: number | null }>;
  versions: Array<{ version: number; name: string; sizeBytes: number; changes: Record<string, number> | null; createdAt: string }>;
  jobs: Array<{ id: string; status: string; stage: string; attempts: number; error: string | null; metrics: Record<string, number>; startedAt: string | null; finishedAt: string | null; createdAt: string }>;
};
type PageRow = { number: number; label: string | null; method: string; status: string; charCount: number; confidence: number | null; error: string | null; startMs: number | null };

const STATUS_COLORS: Record<string, string> = {
  OK: "bg-emerald-500/80",
  PARTIAL: "bg-amber-400",
  EMPTY: "bg-muted-foreground/30",
  FAILED: "bg-destructive",
  SKIPPED: "bg-orange-500",
};
const STATUS_LABELS: Record<string, string> = { OK: "lue", PARTIAL: "lue partiellement", EMPTY: "vide", FAILED: "échec", SKIPPED: "non traitée" };

function SourcesLine({ sources, kind, onOpen }: { sources: InsightSource[]; kind: DocumentKindName; onOpen: (page: number) => void }) {
  const pages = [...new Set(sources.map((s) => s.page).filter((p): p is number => p != null))].sort((a, b) => a - b).slice(0, 20);
  const times = sources.map((s) => s.startMs).filter((t): t is number => t != null);
  if (!pages.length && !times.length) return <span className="text-xs text-muted-foreground">Sources non localisées</span>;
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      Sources :
      {pages.map((p) => (
        <button key={p} type="button" onClick={() => onOpen(p)} className="rounded-full bg-background px-2 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50">
          {locationLabel(kind, { page: p })}
        </button>
      ))}
      {times.slice(0, 10).map((t) => (
        <span key={t} className="rounded-full bg-background px-2 py-0.5">
          {formatMs(t)}
        </span>
      ))}
    </span>
  );
}

function OriginBadge({ origin }: { origin: "EXPLICIT" | "INFERRED" }) {
  return origin === "EXPLICIT" ? <Badge variant="secondary">Décrite par l&apos;auteur</Badge> : <Badge variant="outline">Déduite par l&apos;IA</Badge>;
}

function MethodCard({ insight, kind, onOpen }: { insight: Insight; kind: DocumentKindName; onOpen: (page: number) => void }) {
  const m = insight.content as MethodContent;
  const list = (label: string, items: string[] | undefined) =>
    items?.length ? (
      <div>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <ul className="mt-1 list-disc pl-5 text-sm">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <Panel className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">{m.name}</h3>
        <OriginBadge origin={insight.origin} />
      </div>
      {m.objective && <p className="text-sm">{m.objective}</p>}
      {m.context && <p className="text-sm text-muted-foreground">Contexte : {m.context}</p>}
      {m.steps?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Étapes</p>
          <ol className="mt-1 list-decimal pl-5 text-sm">
            {m.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {list("Prérequis", m.prerequisites)}
        {list("Outils et ressources", m.tools)}
        {list("Règles de décision", m.decisionRules)}
        {list("Entrées", m.inputs)}
        {list("Résultats attendus", m.outputs)}
        {list("Erreurs fréquentes et cas particuliers", m.pitfalls)}
        {list("Limites", m.limits)}
        {list("Exemples", m.examples)}
      </div>
      <SourcesLine sources={insight.sources} kind={kind} onOpen={onOpen} />
    </Panel>
  );
}

export function DocumentDetailView({ projectId, documentId }: { projectId: string; documentId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState("summary");

  const [tick, setTick] = useState(0);
  const load = useCallback(async () => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<Detail>(`/api/projects/${projectId}/documents/${documentId}`)
      .then((d) => !cancelled && setDetail(d))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Document introuvable."));
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId, tick]);

  const processing = detail ? detail.document.stage !== "DONE" && detail.document.status !== "ERROR" : false;
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [processing, load]);

  useEffect(() => {
    if (tab !== "pages") return;
    let cancelled = false;
    api<{ pages: PageRow[] }>(`/api/projects/${projectId}/documents/${documentId}/pages`)
      .then((d) => !cancelled && setPages(d.pages))
      .catch(() => !cancelled && setPages([]));
    return () => {
      cancelled = true;
    };
  }, [tab, projectId, documentId, detail?.document.updatedAt]);

  const active = useMemo(() => detail?.insights.filter((i) => i.status === "ACTIVE") ?? [], [detail]);
  const stale = detail?.insights.filter((i) => i.status !== "ACTIVE").length ?? 0;

  async function reprocess(from: string) {
    try {
      await api(`/api/projects/${projectId}/documents/${documentId}/reprocess`, { method: "POST", json: { from } });
      toast.success("Traitement relancé.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Relance impossible.");
    }
  }

  async function forget(insight: Insight) {
    try {
      await api(`/api/projects/${projectId}/documents/${documentId}/insights/${insight.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Suppression impossible.");
    }
  }

  const back = (
    <Button variant="ghost" asChild>
      <Link href={`/projects/${projectId}`}>
        <ArrowLeft /> Projet
      </Link>
    </Button>
  );
  if (error) return <PageShell title="Document" nav={back}><p className="text-sm text-destructive">{error}</p></PageShell>;
  if (!detail) return <PageShell title="Document" nav={back}><Loader2 className="animate-spin text-muted-foreground" /></PageShell>;

  const d = detail.document;
  const s = statusLine(d);
  const unit = UNIT_LABELS[d.kind];
  const summary = active.find((i) => i.kind === "SUMMARY");
  const methods = active.filter((i) => i.kind === "METHOD");
  const definitions = active.filter((i) => i.kind === "DEFINITION");
  const concepts = active.filter((i) => i.kind === "CONCEPT");
  const rules = active.filter((i) => i.kind === "RULE");
  const warnings = active.filter((i) => i.kind === "CONTRADICTION");
  const relations = active.filter((i) => i.kind === "RELATION" || i.kind === "TIMELINE");
  const analyzed = detail.sections.filter((x) => x.analysisStatus === "DONE").length;

  return (
    <PageShell title={d.name} subtitle={`${KIND_LABELS[d.kind]} · ${formatBytes(d.sizeBytes)}${d.version > 1 ? ` · version ${d.version}` : ""}`} nav={back}>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button asChild>
          <Link href={`/?projectId=${projectId}&documentId=${documentId}`}>
            <MessageSquare /> Interroger ce document
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <a href={originalHref(projectId, documentId, d.kind, {})} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> Original
          </a>
        </Button>
        <Button variant="outline" asChild>
          <a href={`/api/projects/${projectId}/documents/${documentId}/file?download=1`}>
            <Download /> Télécharger
          </a>
        </Button>
      </div>

      <Panel className="mb-4 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <KindIcon kind={d.kind} className="size-5 text-muted-foreground" />
          <p className={cn("text-sm", s.tone === "error" && "text-destructive")}>{s.text}</p>
        </div>
        {processing && <ProgressBar value={overallProgress(d.stage, d.progress)} />}
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {STAGE_ORDER.map((st) => {
            const p = d.progress[PROGRESS_KEY[st]];
            const current = d.stage === st;
            const done = d.stage === "DONE" || STAGE_ORDER.indexOf(d.stage as (typeof STAGE_ORDER)[number]) > STAGE_ORDER.indexOf(st);
            return (
              <li key={st} className={cn(current && "font-medium text-foreground")}>
                {done ? "✓ " : current ? "▸ " : "○ "}
                {STAGE_LABELS[st]}
                {p?.total ? ` ${p.done}/${p.total}` : ""}
                {p?.failed ? ` · ${p.failed} échec(s)` : ""}
                {p?.note && (done || current) ? ` · ${p.note}` : ""}
              </li>
            );
          })}
        </ol>
        {d.warnings.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1 text-xs text-amber-700 dark:text-amber-400">
            {d.warnings.map((w, i) => (
              <li key={i} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            <TabsTrigger value="summary">Synthèse</TabsTrigger>
            <TabsTrigger value="methods">Méthodes{methods.length ? ` (${methods.length})` : ""}</TabsTrigger>
            <TabsTrigger value="concepts">Concepts</TabsTrigger>
            <TabsTrigger value="outline">Plan</TabsTrigger>
            <TabsTrigger value="search">Rechercher</TabsTrigger>
            <TabsTrigger value="pages">{unit.many.replace(/^./, (c) => c.toUpperCase())}</TabsTrigger>
            <TabsTrigger value="processing">Traitement</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="summary">
          <Section title="Synthèse" description="Produite par l'IA à partir de l'analyse de chaque section ; vérifiez les points importants dans les passages originaux.">
            {summary ? (
              <Panel className="flex flex-col gap-3">
                <p className="text-sm leading-6 whitespace-pre-wrap">{(summary.content as { overview?: string }).overview}</p>
                {((summary.content as { keyPoints?: Array<{ text: string; pages: number[] }> }).keyPoints ?? []).length > 0 && (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {(summary.content as { keyPoints: Array<{ text: string; pages: number[] }> }).keyPoints.map((k, i) => (
                      <li key={i}>
                        • {k.text}{" "}
                        {k.pages.map((p) => (
                          <button key={p} type="button" onClick={() => setOpen(p)} className="ml-1 rounded-full bg-background px-1.5 text-xs font-medium hover:bg-accent">
                            {locationLabel(d.kind, { page: p })}
                          </button>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
                {relations.map((r) => (
                  <p key={r.id} className="text-sm whitespace-pre-wrap text-muted-foreground">
                    {r.text}
                  </p>
                ))}
              </Panel>
            ) : (
              <p className="text-sm text-muted-foreground">{processing ? "La synthèse sera disponible à la fin de l'analyse (le document est déjà interrogeable)." : "Aucune synthèse : l'analyse est désactivée ou a échoué (voir Traitement)."}</p>
            )}
          </Section>
          {warnings.length > 0 && (
            <Section title="Points de vigilance" description="Contradictions possibles et passages incertains repérés par l'IA (à vérifier).">
              <div className="flex flex-col gap-2">
                {warnings.map((w) => (
                  <Panel key={w.id} className="flex flex-col gap-2">
                    <p className="text-sm font-medium">{w.title}</p>
                    <p className="text-sm whitespace-pre-wrap">{w.text.split("\n").slice(1).join("\n") || w.text}</p>
                    <SourcesLine sources={w.sources} kind={d.kind} onOpen={setOpen} />
                  </Panel>
                ))}
              </div>
            </Section>
          )}
        </TabsContent>

        <TabsContent value="methods">
          <Section title="Méthodes et procédures" description="Chaque méthode indique si elle est décrite par l'auteur ou reconstituée par l'IA, avec ses pages sources.">
            <div className="flex flex-col gap-3">
              {methods.length === 0 ? <p className="text-sm text-muted-foreground">Aucune méthode extraite pour l&apos;instant.</p> : methods.map((m) => <MethodCard key={m.id} insight={m} kind={d.kind} onOpen={setOpen} />)}
            </div>
          </Section>
          {rules.length > 0 && (
            <Section title="Règles, contraintes et critères">
              {rules.map((r) => (
                <Panel key={r.id}>
                  <p className="text-sm whitespace-pre-wrap">{r.text}</p>
                </Panel>
              ))}
            </Section>
          )}
        </TabsContent>

        <TabsContent value="concepts">
          <Section title="Définitions" description="Telles qu'énoncées dans le document.">
            <div className="flex flex-col gap-2">
              {definitions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune définition extraite.</p>
              ) : (
                definitions.map((x) => (
                  <Panel key={x.id} className="flex flex-col gap-1.5 p-3">
                    <p className="text-sm font-medium">{x.title}</p>
                    {(x.content as { entries: Array<{ definition: string }> }).entries.map((e, i) => (
                      <p key={i} className="text-sm">
                        {e.definition}
                      </p>
                    ))}
                    <SourcesLine sources={x.sources} kind={d.kind} onOpen={setOpen} />
                  </Panel>
                ))
              )}
            </div>
          </Section>
          <Section title="Concepts clés">
            <div className="flex flex-wrap gap-2">
              {concepts.map((c) => (
                <span key={c.id} title={(c.content as { explanations?: string[] }).explanations?.[0]} className="rounded-full bg-muted px-3 py-1 text-sm">
                  {c.title}
                </span>
              ))}
              {concepts.length === 0 && <p className="text-sm text-muted-foreground">Aucun concept extrait.</p>}
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="outline">
          <Section title="Plan du document" description={`${detail.sections.length} section(s) · ${analyzed} analysée(s)`}>
            <ol className="flex flex-col gap-1">
              {detail.sections.map((x) => (
                <li key={x.id} style={{ paddingLeft: `${Math.min(5, x.level - 1) * 1}rem` }}>
                  <button type="button" onClick={() => (x.pageStart ? setOpen(x.pageStart) : undefined)} className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{x.title}</span>
                      {x.analysis?.summary && <span className="line-clamp-2 block text-xs text-muted-foreground">{x.analysis.summary}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{locationLabel(d.kind, { page: x.pageStart, pageEnd: x.pageEnd, startMs: x.startMs, endMs: x.endMs })}</span>
                    {x.analysisStatus === "FAILED" && <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-label="Analyse échouée" />}
                  </button>
                </li>
              ))}
            </ol>
          </Section>
        </TabsContent>

        <TabsContent value="search">
          <Section title="Rechercher dans ce document">
            <DocumentSearch projectId={projectId} documents={[{ id: d.id, name: d.name, kind: d.kind }]} fixedDocumentId={d.id} />
          </Section>
        </TabsContent>

        <TabsContent value="pages">
          <Section
            title="Couverture"
            description={detail.pageStats.map((p) => `${p.count} ${STATUS_LABELS[p.status] ?? p.status}${p.method === "OCR" ? " (OCR)" : p.method === "TRANSCRIPT" ? " (transcription)" : ""}`).join(" · ")}
            actions={
              detail.issues.some((i) => i.status === "FAILED" || i.status === "SKIPPED") ? (
                <Button variant="outline" size="sm" onClick={() => void reprocess("OCR")}>
                  <RefreshCw /> Relire les unités non traitées
                </Button>
              ) : null
            }
          >
            {pages === null ? (
              <Loader2 className="animate-spin text-muted-foreground" />
            ) : (
              <>
                <div className="flex flex-wrap gap-1" role="list" aria-label="État de chaque unité">
                  {pages.map((p) => (
                    <button
                      key={p.number}
                      type="button"
                      role="listitem"
                      onClick={() => setOpen(p.number)}
                      title={`${p.label ?? p.number} : ${STATUS_LABELS[p.status] ?? p.status}${p.error ? ` — ${p.error}` : ""}`}
                      aria-label={`${p.label ?? p.number} : ${STATUS_LABELS[p.status] ?? p.status}`}
                      className={cn("size-3.5 rounded-[3px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50", STATUS_COLORS[p.status] ?? "bg-muted")}
                    />
                  ))}
                </div>
                <p className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {Object.entries(STATUS_LABELS).map(([k, v]) => (
                    <span key={k} className="flex items-center gap-1">
                      <span className={cn("inline-block size-2.5 rounded-[2px]", STATUS_COLORS[k])} /> {v}
                    </span>
                  ))}
                </p>
                {detail.issues.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-1 text-sm">
                    {detail.issues.slice(0, 100).map((i) => (
                      <li key={i.number}>
                        <button type="button" className="text-left hover:underline" onClick={() => setOpen(i.number)}>
                          {i.label ?? `Unité ${i.number}`} — {STATUS_LABELS[i.status] ?? i.status}
                          {i.error ? ` : ${i.error}` : ""}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="processing">
          <Section
            title="Traitement"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void reprocess("ANALYZE")}>
                  <RefreshCw /> Refaire l&apos;analyse
                </Button>
                <Button variant="outline" size="sm" onClick={() => void reprocess("EXTRACT")}>
                  <RefreshCw /> Tout retraiter
                </Button>
              </div>
            }
          >
            <div className="flex flex-col gap-2">
              {detail.jobs.map((j) => (
                <Panel key={j.id} className="p-3 text-sm">
                  <p className="font-medium">
                    {formatDate(j.createdAt)} · {j.status === "DONE" ? "terminé" : j.status === "FAILED" ? "échec" : j.status === "CANCELLED" ? "annulé" : j.status === "RUNNING" ? `en cours (${STAGE_LABELS[j.stage] ?? j.stage})` : "en attente"}
                    {j.attempts > 1 ? ` · ${j.attempts} tentatives` : ""}
                  </p>
                  {j.error && <p className="text-xs text-destructive">{j.error}</p>}
                  {Object.keys(j.metrics ?? {}).length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[
                        j.metrics.totalMs ? `durée ${Math.round(j.metrics.totalMs / 1000)} s` : null,
                        j.metrics.extractMs ? `extraction ${Math.round(j.metrics.extractMs / 1000)} s` : null,
                        j.metrics.ocrMs ? `OCR ${Math.round(j.metrics.ocrMs / 1000)} s` : null,
                        j.metrics.transcribeMs ? `transcription ${Math.round(j.metrics.transcribeMs / 1000)} s` : null,
                        j.metrics.embedMs ? `embeddings ${Math.round(j.metrics.embedMs / 1000)} s` : null,
                        j.metrics.analyzeMs ? `analyse ${Math.round(j.metrics.analyzeMs / 1000)} s (${j.metrics.analysisCalls ?? 0} appels)` : null,
                        j.metrics.segments ? `${j.metrics.segments} passages` : null,
                        j.metrics.embedReused ? `${j.metrics.embedReused} vecteurs réutilisés` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </Panel>
              ))}
            </div>
          </Section>
          {detail.versions.length > 0 && (
            <Section title="Versions">
              <ul className="flex flex-col gap-1 text-sm">
                {detail.versions.map((v) => (
                  <li key={v.version}>
                    v{v.version} · {v.name} · {formatBytes(v.sizeBytes)} · {formatDate(v.createdAt)}
                    {v.changes ? ` · ${v.changes.segmentsNew ?? 0} passage(s) nouveaux, ${v.changes.segmentsReused ?? 0} réutilisés, ${v.changes.sectionsChanged ?? 0} section(s) réanalysée(s)` : ""}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {active.length + stale > 0 && (
            <Section title="Connaissances mémorisées" description={`${active.length} active(s)${stale ? ` · ${stale} d'une version précédente (conservées pour traçabilité, jamais utilisées)` : ""}. Vous pouvez retirer une connaissance erronée : les passages originaux restent interrogeables.`}>
              <ul className="flex flex-col gap-1">
                {active.map((i) => (
                  <li key={i.id} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline">{i.kind}</Badge>
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    <Button variant="ghost" size="icon-xs" aria-label={`Retirer ${i.title}`} onClick={() => void forget(i)}>
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </TabsContent>
      </Tabs>
      {open != null && <PageViewer projectId={projectId} documentId={documentId} page={open} onClose={() => setOpen(null)} />}
    </PageShell>
  );
}
