"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/client/api";
import type { ExploreResult } from "@/lib/documents/explore";
import type { DocumentKindName } from "@/lib/documents/types";
import { locationLabel } from "./format";
import { Highlighted, PageViewer } from "./page-viewer";

const MODES = [
  { value: "hybrid", label: "Par le sens et les mots" },
  { value: "exact", label: "Expression exacte" },
  { value: "occurrences", label: "Toutes les occurrences" },
] as const;

const TYPES = [
  { value: "", label: "Tous les contenus" },
  { value: "TABLE", label: "Tableaux" },
  { value: "CAPTION", label: "Légendes" },
  { value: "OCR", label: "Texte lu par OCR" },
  { value: "TRANSCRIPT", label: "Transcriptions" },
  { value: "VISUAL", label: "Images analysées" },
];

const TYPE_LABELS: Record<string, string> = { TABLE: "tableau", CAPTION: "légende", OCR: "OCR", TRANSCRIPT: "transcription", VISUAL: "image", NOTE: "notes" };

/** Recherche de passages précis dans un ou plusieurs documents, avec filtres et accès au passage original. */
export function DocumentSearch({ projectId, documents, fixedDocumentId }: { projectId: string; documents: Array<{ id: string; name: string; kind: DocumentKindName }>; fixedDocumentId?: string }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("hybrid");
  const [type, setType] = useState("");
  const [doc, setDoc] = useState(fixedDocumentId ?? "");
  const [pageFrom, setPageFrom] = useState("");
  const [pageTo, setPageTo] = useState("");
  const [section, setSection] = useState("");
  const [result, setResult] = useState<ExploreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<{ documentId: string; page: number } | null>(null);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams({ q: q.trim(), mode });
    if (doc) sp.append("documentId", doc);
    if (type) sp.set("type", type);
    if (/^\d+$/.test(pageFrom)) sp.set("pageFrom", pageFrom);
    if (/^\d+$/.test(pageTo)) sp.set("pageTo", pageTo);
    if (section.trim()) sp.set("section", section.trim());
    try {
      setResult(await api<ExploreResult>(`/api/projects/${projectId}/documents/search?${sp}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Recherche impossible.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={(e) => void run(e)} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex. procédure de calibration, « seuil critique », critères de décision…" aria-label="Rechercher dans les documents" />
          <Button type="submit" disabled={loading || q.trim().length < 2}>
            {loading ? <Loader2 className="animate-spin" /> : <Search />}
            <span className="sr-only sm:not-sr-only">Rechercher</span>
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
            <SelectTrigger aria-label="Mode de recherche" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={type || "all"} onValueChange={(v) => setType(v === "all" ? "" : v)}>
            <SelectTrigger aria-label="Type de contenu" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t.value || "all"} value={t.value || "all"}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!fixedDocumentId && (
            <Select value={doc || "all"} onValueChange={(v) => setDoc(v === "all" ? "" : v)}>
              <SelectTrigger aria-label="Document" className="col-span-2 w-full sm:col-span-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les documents</SelectItem>
                {documents.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input value={pageFrom} onChange={(e) => setPageFrom(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Page de…" aria-label="Page de début" />
          <Input value={pageTo} onChange={(e) => setPageTo(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="à…" aria-label="Page de fin" />
          <Input value={section} onChange={(e) => setSection(e.target.value)} placeholder="Chapitre ou section (ex. chapitre 3)" aria-label="Chapitre ou section" className="col-span-2" />
        </div>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {result.mode === "occurrences" || result.mode === "exact"
              ? `${result.occurrences ?? 0} occurrence(s) dans ${result.total} passage(s)`
              : `${result.total} passage(s) · ${result.semantic ? "recherche lexicale (BM25) + sémantique" : "recherche lexicale (BM25)"}`}{" "}
            · {result.durationMs} ms
            {result.semanticError ? ` · recherche sémantique indisponible : ${result.semanticError}` : ""}
          </p>
          {result.results.length === 0 && <p className="text-sm text-muted-foreground">Aucun passage ne correspond. Essayez d&apos;autres termes ou retirez des filtres.</p>}
          {result.results.map((r) => {
            const loc = locationLabel(r.kind, { page: r.page, pageEnd: r.pageEnd, startMs: r.matchMs ?? r.startMs, endMs: r.matchMs != null ? null : r.endMs });
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => r.page != null && setOpen({ documentId: r.documentId, page: r.page })}
                className="rounded-2xl bg-background p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{r.documentName}</span>
                  {loc && <span>{loc}</span>}
                  {r.section && <span className="truncate">· {r.section}</span>}
                  {TYPE_LABELS[r.type] && <span>· {TYPE_LABELS[r.type]}</span>}
                  {r.occurrences && r.occurrences > 1 ? <span>· {r.occurrences} occurrences</span> : null}
                </span>
                <span className="mt-1 line-clamp-4 block text-sm">
                  <Highlighted text={r.snippet} term={mode === "hybrid" ? (q.match(/[«"“]([^»"”]+)[»"”]/)?.[1] ?? null) : q} />
                </span>
              </button>
            );
          })}
        </div>
      )}
      {open && <PageViewer projectId={projectId} documentId={open.documentId} page={open.page} highlight={mode === "hybrid" ? null : q} onClose={() => setOpen(null)} />}
    </div>
  );
}
