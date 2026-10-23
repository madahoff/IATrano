"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BookOpen, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { KindIcon } from "@/components/documents/document-library";
import { api } from "@/lib/client/api";
import type { DocumentListItem } from "@/lib/documents/service";
import { cn } from "@/lib/utils";
import { setDocumentScope } from "./scope-store";

/**
 * Choix des documents du projet interrogés par la conversation ([] : tous). La sélection est transmise avec
 * le prochain message (useChat) et enregistrée sur la conversation ; elle est aussi appliquée immédiatement
 * si la conversation existe déjà. `?documentId=` (bouton « Interroger ce document ») présélectionne un document.
 */
export function DocumentScopeButton({ projectId, conversationId, initial }: { projectId: string; conversationId?: string | null; initial?: string[] }) {
  const params = useSearchParams();
  const preset = params.get("documentId");
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [selected, setSelected] = useState<string[]>(() => initial?.length ? initial : preset ? [preset] : []);

  useEffect(() => {
    let cancelled = false;
    api<{ documents: DocumentListItem[] }>(`/api/projects/${projectId}/documents`)
      .then((d) => !cancelled && setDocs(d.documents))
      .catch(() => !cancelled && setDocs([]));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    setDocumentScope({ projectId, documentIds: selected });
    return () => setDocumentScope({ projectId: null, documentIds: null });
  }, [projectId, selected]);

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setSelected(next);
    if (conversationId) void api(`/api/conversations/${conversationId}`, { method: "PATCH", json: { documentIds: next } }).catch(() => {});
  }

  function all() {
    setSelected([]);
    if (conversationId) void api(`/api/conversations/${conversationId}`, { method: "PATCH", json: { documentIds: [] } }).catch(() => {});
  }

  if (docs !== null && docs.length === 0) return null;
  const ready = (docs ?? []).filter((d) => d.status === "READY");
  const label = selected.length === 0 ? "Tous les documents" : selected.length === 1 ? (docs?.find((d) => d.id === selected[0])?.name ?? "1 document") : `${selected.length} documents`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-56 rounded-full" aria-label={`Documents interrogés : ${label}`}>
          <BookOpen />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] rounded-2xl p-2" align="start">
        <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">Documents du projet consultés pour les prochaines réponses</p>
        <button type="button" onClick={all} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-muted">
          <Check className={cn("size-4", selected.length ? "opacity-0" : "")} /> Tous les documents
        </button>
        {(docs ?? []).map((d) => (
          <button key={d.id} type="button" disabled={d.status !== "READY"} onClick={() => toggle(d.id)} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50">
            <Check className={cn("size-4 shrink-0", selected.includes(d.id) ? "" : "opacity-0")} />
            <KindIcon kind={d.kind} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            {d.status !== "READY" && <span className="shrink-0 text-xs text-muted-foreground">en traitement</span>}
          </button>
        ))}
        {ready.length === 0 && docs !== null && <p className="px-2 py-2 text-xs text-muted-foreground">Aucun document prêt pour l&apos;instant.</p>}
      </PopoverContent>
    </Popover>
  );
}
