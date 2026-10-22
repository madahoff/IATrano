"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { PageShell, Panel, Section } from "@/components/layout/page-shell";
import { formatDate } from "@/lib/format";

type Page = { number: number; label: string | null; method: string | null; status: string; charCount: number; confidence: number | null; error: string | null; startMs: number | null; endMs: number | null; hasImage: boolean };
type Detail = {
  document: { id: string; name: string; kind: string; sizeBytes: number; status: string; stage: string; error: string | null; version: number; unitCount: number | null; progress: { completed?: number; total?: number; label?: string }; warnings: string[]; segments: number; createdAt: string; updatedAt: string; indexedAt: string | null; analyzedAt: string | null; metadata: unknown; language: string | null };
  sections: Array<{ id: string; ordinal: number; level: number; title: string | null; path: string | null; pageStart: number | null; pageEnd: number | null; analysisStatus: string; analysis: unknown }>;
  insights: Array<{ id: string; kind: string; title: string; content: string | null; text: string | null; origin: string; status: string; sources: unknown }>;
  pageStats: Array<{ status: string; method: string; count: number }>;
  issues: Array<{ number: number; label: string | null; status: string; method: string; error: string | null; confidence: number | null }>;
  versions: Array<{ version: number; name: string; sizeBytes: number; checksum: string; createdAt: string }>;
  jobs: Array<{ id: string; status: string; stage: string; attempts: number; error: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string }>;
};

const size = (n: number) => `${(n / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Ko`;
const labelStatus = (s: string) => ({ READY: "Prêt", PENDING: "En attente", RUNNING: "Traitement", ERROR: "Erreur", COMPLETE: "Terminé", FAILED: "Échec" })[s] ?? s;

export function DocumentDetailView({ projectId, documentId }: { projectId: string; documentId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [pageText, setPageText] = useState<{ number: number; label: string | null; text: string | null; visual: string | null; section: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([
      api<Detail>(`/api/projects/${projectId}/documents/${documentId}`),
      api<{ pages: Page[] }>(`/api/projects/${projectId}/documents/${documentId}/pages`),
    ]);
    setDetail(d); setPages(p.pages);
  }, [projectId, documentId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((e) => setError(e instanceof ApiError ? e.message : "Document introuvable.")); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!detail || !["PENDING", "RUNNING"].includes(detail.document.status)) return;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 2500);
    return () => window.clearInterval(timer);
  }, [detail, load]);

  async function openPage(number: number) {
    setSelectedPage(number); setPageText(null);
    try { setPageText(await api(`/api/projects/${projectId}/documents/${documentId}/pages/${number}`)); } catch (e) { setError(e instanceof ApiError ? e.message : "Lecture de la page impossible."); }
  }

  async function reprocess(from: "EXTRACT" | "OCR" | "ANALYZE") {
    setBusy(true); setError(null);
    try { await api(`/api/projects/${projectId}/documents/${documentId}/reprocess`, { method: "POST", json: { from } }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Relance impossible."); }
    finally { setBusy(false); }
  }

  if (error && !detail) return <PageShell title="Document"><Panel className="text-sm text-destructive">{error}</Panel></PageShell>;
  if (!detail) return <PageShell title="Document"><Loader2 className="animate-spin" /></PageShell>;
  const d = detail.document;
  const progress = d.progress.total ? Math.min(100, Math.round(((d.progress.completed ?? 0) / d.progress.total) * 100)) : null;

  return <PageShell title={d.name} subtitle={`${d.kind} · version ${d.version}`} nav={<Button variant="ghost" asChild><Link href={`/projects/${projectId}`}><ArrowLeft /> Projet</Link></Button>} headerExtra={<Button variant="ghost" size="icon" onClick={() => void load()} aria-label="Actualiser"><RefreshCw /></Button>}>
    {error && <Panel className="mb-4 text-sm text-destructive">{error}</Panel>}
    <div className="mb-4 flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => void reprocess("EXTRACT")}><RotateCcw /> Retraiter</Button><Button variant="outline" disabled={busy} onClick={() => void reprocess("ANALYZE")}>Refaire l’analyse</Button></div>
    <Section title="État du traitement" description={`${labelStatus(d.status)} · ${d.stage} · ${size(d.sizeBytes)} · ${d.segments} segment(s)`}>
      <Panel>{progress !== null && <><div className="mb-2 flex justify-between text-xs text-muted-foreground"><span>{d.progress.label ?? "Progression"}</span><span>{progress} %</span></div><div className="h-2 overflow-hidden rounded-full bg-background"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div></>}{d.error && <p className="mt-3 text-sm text-destructive">{d.error}</p>}{d.warnings.length > 0 && <ul className="mt-3 space-y-1 text-sm text-amber-700">{d.warnings.map((w) => <li key={w}><AlertTriangle className="mr-1 inline size-4" />{w}</li>)}</ul>}</Panel>
    </Section>
    <Section title="Pages et couverture" description="Les pages signalées comme incomplètes restent visibles afin de ne pas masquer les limites d’extraction.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{detail.pageStats.map((s) => <Panel key={`${s.status}-${s.method}`} className="p-3"><p className="text-lg font-semibold">{s.count}</p><p className="text-xs text-muted-foreground">{labelStatus(s.status)} · {s.method}</p></Panel>)}</div>
      {detail.issues.length > 0 && <Panel className="mt-3 text-sm"><p className="font-medium">Pages à vérifier</p><ul className="mt-2 space-y-1">{detail.issues.map((i) => <li key={i.number}><button className="text-left text-primary underline-offset-2 hover:underline" onClick={() => void openPage(i.number)}>Page {i.number}</button> · {labelStatus(i.status)}{i.error ? ` — ${i.error}` : ""}</li>)}</ul></Panel>}
    </Section>
    <Section title="Lecture des pages">
      <div className="flex flex-wrap gap-1">{pages.slice(0, 500).map((p) => <Button key={p.number} variant={selectedPage === p.number ? "default" : "outline"} size="xs" onClick={() => void openPage(p.number)}>{p.number}</Button>)}</div>
      {pageText && <Panel className="mt-4"><p className="mb-2 text-xs text-muted-foreground">Page {pageText.number}{pageText.label ? ` · ${pageText.label}` : ""}{pageText.section ? ` · ${pageText.section}` : ""}</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm">{pageText.text || pageText.visual || "Aucun texte extrait pour cette page."}</pre></Panel>}
    </Section>
    <Section title="Synthèses et connaissances">
      {detail.insights.length === 0 ? <p className="text-sm text-muted-foreground">Aucune synthèse disponible pour le moment.</p> : <div className="space-y-2">{detail.insights.map((i) => <Panel key={i.id}><p className="font-medium">{i.title}</p><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{i.content ?? i.text}</p></Panel>)}</div>}
    </Section>
    <Section title="Sections analysées"><div className="space-y-1">{detail.sections.map((s) => <div key={s.id} className="flex justify-between gap-3 border-b border-border/50 py-2 text-sm"><span>{s.path ?? s.title ?? `Section ${s.ordinal}`}</span><span className="text-muted-foreground">{labelStatus(s.analysisStatus)}</span></div>)}</div></Section>
    <p className="pb-6 text-xs text-muted-foreground">Importé le {formatDate(d.createdAt)} · dernière modification {formatDate(d.updatedAt)}{d.indexedAt ? ` · indexé le ${formatDate(d.indexedAt)}` : ""}</p>
  </PageShell>;
}
