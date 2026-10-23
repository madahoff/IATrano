"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/client/api";
import type { DocumentKindName, VisualAnalysis } from "@/lib/documents/types";
import { locationLabel, originalHref } from "./format";

type PageData = {
  document: { id: string; name: string; kind: DocumentKindName; unitCount: number | null; hasOriginal: boolean };
  page: { number: number; label: string | null; method: string; status: string; confidence: number | null; error: string | null; text: string; visual: VisualAnalysis | null; startMs: number | null; endMs: number | null; hasImage: boolean };
  section: string[] | null;
};

const METHOD: Record<string, string> = { TEXT: "texte extrait", OCR: "lu par OCR", TRANSCRIPT: "transcription", KEYFRAME: "image clé", NONE: "non lu" };

/** Passage original : texte extrait de l'unité, image rendue, lien vers le fichier à la bonne page / au bon moment. */
export function PageViewer({ projectId, documentId, page, highlight, onClose }: { projectId: string; documentId: string; page: number | null; highlight?: string | null; onClose: () => void }) {
  const [current, setCurrent] = useState(page);
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prevPage, setPrevPage] = useState(page);
  if (page !== prevPage) {
    setPrevPage(page);
    setCurrent(page);
  }

  useEffect(() => {
    if (current == null) return;
    let cancelled = false;
    api<PageData>(`/api/projects/${projectId}/documents/${documentId}/pages/${current}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Passage introuvable."));
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId, current]);

  const shown = data && data.page.number === current ? data : null;
  const loc = shown ? locationLabel(shown.document.kind, { page: shown.page.number, startMs: shown.page.startMs, endMs: shown.page.endMs }) : null;
  const total = shown?.document.unitCount ?? null;

  return (
    <Dialog open={page != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{shown ? `${shown.document.name} — ${shown.page.label ?? loc}` : "Passage original"}</DialogTitle>
          <DialogDescription>
            {shown ? [shown.section?.join(" › "), METHOD[shown.page.method] ?? shown.page.method, shown.page.confidence != null ? `confiance ${Math.round(shown.page.confidence * 100)} %` : null].filter(Boolean).join(" · ") : "Chargement…"}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!shown && !error && <Loader2 className="animate-spin text-muted-foreground" />}
        {shown && (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-muted p-4">
            {shown.page.error && <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">{shown.page.error}</p>}
            {shown.page.hasImage && (
              // Image servie par l'API avec un type fixe (jamais du HTML).
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/projects/${projectId}/documents/${documentId}/pages/${shown.page.number}/image`} alt={`Rendu de ${shown.page.label ?? `l'unité ${shown.page.number}`}`} className="mb-3 max-h-80 w-auto rounded-xl bg-background" loading="lazy" />
            )}
            {shown.page.visual && (
              <p className="mb-3 text-sm">
                <span className="font-medium">Analyse visuelle ({shown.page.visual.model}) : </span>
                {shown.page.visual.description}
              </p>
            )}
            <Highlighted text={shown.page.text || "(aucun texte extrait pour cette unité)"} term={highlight ?? null} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={!current || current <= 1} onClick={() => setCurrent((c) => (c ? c - 1 : c))}>
            <ChevronLeft /> Précédente
          </Button>
          <Button variant="outline" size="sm" disabled={!current || (total != null && current >= total)} onClick={() => setCurrent((c) => (c ? c + 1 : c))}>
            Suivante <ChevronRight />
          </Button>
          {shown?.document.hasOriginal && (
            <Button variant="secondary" size="sm" className="ml-auto" asChild>
              <a href={originalHref(projectId, documentId, shown.document.kind, { page: shown.page.number, startMs: shown.page.startMs })} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Ouvrir l&apos;original{loc ? ` (${loc})` : ""}
              </a>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Texte préformaté avec surlignage des occurrences d'un terme (insensible aux accents). */
export function Highlighted({ text, term }: { text: string; term: string | null }) {
  const parts: Array<{ t: string; hit: boolean }> = [];
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = term ? fold(term.replace(/[«»"“”]/g, "").trim()) : "";
  if (needle.length >= 2) {
    // La normalisation NFD conserve les positions pour le texte latin courant (un caractère accentué → base + diacritique retiré).
    const folded = [...text].map((c) => fold(c) || c).join("");
    let i = 0;
    for (;;) {
      const at = folded.indexOf(needle, i);
      if (at < 0) break;
      if (at > i) parts.push({ t: text.slice(i, at), hit: false });
      parts.push({ t: text.slice(at, at + needle.length), hit: true });
      i = at + needle.length;
    }
    parts.push({ t: text.slice(i), hit: false });
  } else parts.push({ t: text, hit: false });
  return (
    <span className="block text-sm leading-6 break-words whitespace-pre-wrap">
      {parts.map((p, i) => (p.hit ? <mark key={i} className="rounded bg-amber-200 px-0.5 text-foreground dark:bg-amber-500/40">{p.t}</mark> : <span key={i}>{p.t}</span>))}
    </span>
  );
}
