"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Loader2, Presentation, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Panel, Section } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import type { DocumentListItem } from "@/lib/documents/service";
import type { DocumentKindName } from "@/lib/documents/types";
import { cn } from "@/lib/utils";
import { ACCEPT, formatBytes, KIND_LABELS, overallProgress, STAGE_LABELS, UNIT_LABELS } from "./format";
import { uploadDocument } from "./upload";
import { DocumentSearch } from "./document-search";

const ICONS: Record<DocumentKindName, typeof FileText> = { PDF: FileText, DOCX: FileText, PPTX: Presentation, XLSX: FileSpreadsheet, CSV: FileSpreadsheet, TEXT: FileText, MARKDOWN: FileText, JSON: FileText, HTML: FileText, IMAGE: FileImage, VIDEO: FileVideo, AUDIO: FileAudio };

type Uploading = { key: string; name: string; size: number; fraction: number; controller: AbortController; error?: string };

export function KindIcon({ kind, className }: { kind: DocumentKindName; className?: string }) {
  const Icon = ICONS[kind] ?? FileText;
  return <Icon className={className} aria-hidden />;
}

export function ProgressBar({ value, tone = "default" }: { value: number; tone?: "default" | "error" }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-background" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", tone === "error" ? "bg-destructive" : "bg-primary")} style={{ width: `${Math.max(2, Math.round(value * 100))}%` }} />
    </div>
  );
}

/** Ligne d'état : ce qui est fait, ce qui reste, les limites — jamais « prêt » sans le dire précisément. */
export function statusLine(d: DocumentListItem) {
  const unit = UNIT_LABELS[d.kind];
  const units = d.unitCount ? `${d.unitCount} ${d.unitCount > 1 ? unit.many : unit.one}` : null;
  if (d.status === "ERROR") return { tone: "error" as const, text: d.error ?? "Traitement impossible." };
  if (d.stage === "DONE") return { tone: d.warnings.length ? ("warn" as const) : ("ok" as const), text: [units, `${d.segments} passages indexés`, d.analyzedAt ? "analysé" : null, d.warnings.length ? `${d.warnings.length} limite(s)` : null].filter(Boolean).join(" · ") };
  const p = d.progress;
  const detail =
    d.stage === "EXTRACT" && p.extract?.total ? `${p.extract.done}/${p.extract.total} ${unit.many}` :
    d.stage === "OCR" && p.ocr?.total ? `${p.ocr.done}/${p.ocr.total}` :
    d.stage === "EMBED" && p.embed?.total ? `${p.embed.done}/${p.embed.total} passages` :
    d.stage === "ANALYZE" && p.analyze?.total ? `${p.analyze.done}/${p.analyze.total} sections` : null;
  const searchable = d.status === "READY" ? "déjà interrogeable · " : "";
  const retry = d.job?.status === "PENDING" && d.job.attempts > 0 && d.job.error ? ` · nouvelle tentative (${d.job.error.slice(0, 80)})` : "";
  return { tone: "busy" as const, text: `${searchable}${STAGE_LABELS[d.stage] ?? d.stage}${detail ? ` (${detail})` : ""}${retry}` };
}

export function DocumentLibrary({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [confirm, setConfirm] = useState<DocumentListItem | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ documents: DocumentListItem[] }>(`/api/projects/${projectId}/documents`);
      setDocs(d.documents);
    } catch {
      setDocs((prev) => prev ?? []);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Suivi du traitement en arrière-plan : actualisation tant qu'un document n'est pas terminé.
  const busy = docs?.some((d) => d.stage !== "DONE" && d.status !== "ERROR") ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [busy, load]);

  async function send(files: File[], replaceId: string | null) {
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Date.now()}`;
      const controller = new AbortController();
      setUploads((u) => [...u, { key, name: file.name, size: file.size, fraction: 0, controller }]);
      try {
        const r = await uploadDocument(projectId, file, { replaceId: replaceId ?? undefined, signal: controller.signal, onProgress: (fraction) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, fraction } : x))) });
        setUploads((u) => u.filter((x) => x.key !== key));
        const outcome = r.outcomes[0];
        if (outcome === "duplicate") toast.info(`« ${file.name} » est déjà dans le projet (contenu identique) : aucun retraitement.`);
        else if (outcome === "new_version") toast.success(`Nouvelle version de « ${file.name} » importée : seules les parties modifiées seront réanalysées.`);
        else toast.success(`« ${file.name} » importé : traitement en arrière-plan.`);
        await load();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setUploads((u) => u.filter((x) => x.key !== key));
          continue;
        }
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: err instanceof Error ? err.message : "Import impossible." } : x)));
      }
    }
  }

  function pick(replaceId: string | null) {
    replaceTarget.current = replaceId;
    input.current?.click();
  }

  async function reprocess(d: DocumentListItem) {
    try {
      await api(`/api/projects/${projectId}/documents/${d.id}/reprocess`, { method: "POST", json: { from: "EXTRACT" } });
      toast.success(`Retraitement de « ${d.name} » lancé.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Retraitement impossible.");
    }
  }

  async function remove(d: DocumentListItem) {
    try {
      await api(`/api/projects/${projectId}/documents/${d.id}`, { method: "DELETE" });
      toast.success(`« ${d.name} » et tout ce qui en dérive (index, synthèses, méthodes) ont été supprimés.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Suppression impossible.");
    }
  }

  const ready = docs?.filter((d) => d.status === "READY").length ?? 0;

  return (
    <Section
      title="Documents"
      description="PDF (même numérisés), Word, PowerPoint, Excel, CSV, textes, images, vidéos et audio. Ils sont lus, découpés, indexés et analysés en arrière-plan ; les conversations du projet les interrogent sans les charger entièrement."
      actions={
        <div className="flex flex-wrap gap-2">
          {ready > 0 && (
            <Button variant="outline" onClick={() => setSearchOpen((v) => !v)} aria-expanded={searchOpen}>
              <Search /> Rechercher
            </Button>
          )}
          <Button variant="secondary" onClick={() => pick(null)}>
            <Upload /> Importer
          </Button>
        </div>
      }
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void send(replaceTarget.current ? files.slice(0, 1) : files, replaceTarget.current);
        }}
      />
      {searchOpen && (
        <Panel className="mb-3">
          <DocumentSearch projectId={projectId} documents={(docs ?? []).filter((d) => d.status === "READY")} />
        </Panel>
      )}
      <div className="flex flex-col gap-2">
        {uploads.map((u) => (
          <Panel key={u.key} className="flex items-center gap-3 p-3">
            {u.error ? <AlertTriangle className="size-5 shrink-0 text-destructive" /> : <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{u.name}</p>
              {u.error ? <p className="text-xs text-destructive">{u.error}</p> : <ProgressBar value={u.fraction} />}
              {!u.error && <p className="mt-1 text-xs text-muted-foreground">Envoi · {Math.round(u.fraction * 100)} % de {formatBytes(u.size)}</p>}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={u.error ? "Fermer" : "Annuler l'envoi"} onClick={() => (u.error ? setUploads((x) => x.filter((y) => y.key !== u.key)) : u.controller.abort())}>
              <X />
            </Button>
          </Panel>
        ))}
        {docs === null ? (
          <Loader2 className="animate-spin text-muted-foreground" />
        ) : docs.length === 0 && uploads.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun document. Importez des fichiers pour que les conversations du projet puissent s&apos;y référer.</p>
        ) : (
          docs.map((d) => {
            const s = statusLine(d);
            return (
              <Panel key={d.id} className="flex items-start gap-3 p-3">
                <KindIcon kind={d.kind} className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <Link href={`/projects/${projectId}/documents/${d.id}`} className="block truncate rounded-sm text-sm font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                    {d.name}
                  </Link>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {s.tone === "ok" && <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    {s.tone === "warn" && <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />}
                    {s.tone === "error" && <AlertTriangle className="size-3.5 shrink-0 text-destructive" />}
                    <span className={cn("min-w-0", s.tone === "error" && "text-destructive")}>
                      {KIND_LABELS[d.kind]} · {formatBytes(d.sizeBytes)}
                      {d.version > 1 ? ` · v${d.version}` : ""} · {s.text}
                    </span>
                  </p>
                  {s.tone === "busy" && (
                    <div className="mt-2">
                      <ProgressBar value={overallProgress(d.stage, d.progress)} />
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon-sm" aria-label={`Importer une nouvelle version de ${d.name}`} title="Nouvelle version" onClick={() => pick(d.id)}>
                    <Upload />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Relancer le traitement de ${d.name}`} title="Relancer le traitement" onClick={() => void reprocess(d)}>
                    <RefreshCw />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Supprimer ${d.name}`} title="Supprimer" onClick={() => setConfirm(d)}>
                    <Trash2 />
                  </Button>
                </div>
              </Panel>
            );
          })
        )}
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer « {confirm?.name} » ?</AlertDialogTitle>
            <AlertDialogDescription>Le fichier original, son index, ses synthèses, ses méthodes extraites et les souvenirs du projet qui en proviennent seront supprimés. Les réponses déjà données conservent seulement leurs références.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) void remove(confirm);
                setConfirm(null);
              }}
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
