"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { ChatFilePreview } from "@/lib/files/chat-files";
import { cn } from "@/lib/utils";
import { ErrorNotice, errorMessage, Loading, ReadOnlyNote, ViewerToolbar, type ViewerProps } from "./common";

/** Aperçu structuré calculé par le serveur (classeur, présentation, paragraphes Word), rechargé à chaque version. */
export function usePreview<T extends ChatFilePreview["type"]>(file: ViewerProps["file"], type: T) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data: Extract<ChatFilePreview, { type: T }> } | { key: string; error: string } | null>(null);
  const key = `${file.id}:${file.version}:${attempt}`;
  useEffect(() => {
    let cancelled = false;
    api<ChatFilePreview>(`/api/chat/files/${file.id}/preview?v=${file.version}`)
      .then((data) => {
        if (data.type !== type) throw new Error("Aperçu inattendu.");
        if (!cancelled) setState({ key, data: data as Extract<ChatFilePreview, { type: T }> });
      })
      .catch((err) => !cancelled && setState({ key, error: errorMessage(err, "Aperçu indisponible : vérifiez votre connexion.") }));
    return () => {
      cancelled = true;
    };
  }, [file.id, file.version, type, key]);
  return { state: state?.key === key ? state : null, reload: () => setAttempt((n) => n + 1) };
}

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Classeur Excel : feuilles et valeurs enregistrées des cellules (formules non recalculées), en lecture seule. */
export function XlsxViewer({ file }: ViewerProps) {
  const { state, reload } = usePreview(file, "xlsx");
  const [sheet, setSheet] = useState(0);
  if (!state) return <Loading />;
  if ("error" in state) return <ErrorNotice message={state.error} onRetry={reload} />;
  const sheets = state.data.sheets;
  const current = sheets[Math.min(sheet, sheets.length - 1)];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="Feuilles">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === sheet}
              onClick={() => setSheet(i)}
              className={cn("shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors", i === sheet ? "bg-secondary" : "text-muted-foreground hover:bg-muted")}
            >
              {s.name}
            </button>
          ))}
        </div>
        <ReadOnlyNote>Lecture seule</ReadOnlyNote>
      </ViewerToolbar>
      {!current || !current.rows.length ? (
        <p className="p-6 text-sm text-muted-foreground">Feuille vide.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="sticky left-0 z-10 w-10 border-r border-b border-border bg-muted" />
                {Array.from({ length: current.width }, (_, c) => (
                  <th key={c} scope="col" className="min-w-24 border-r border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
                    {colName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {current.rows.map((row) => (
                <tr key={row.number}>
                  <th scope="row" className="sticky left-0 border-r border-b border-border bg-muted px-2 text-right font-normal text-muted-foreground tabular-nums">
                    {row.number}
                  </th>
                  {Array.from({ length: current.width }, (_, c) => (
                    <td key={c} className={cn("max-w-80 truncate border-r border-b border-border px-2 py-1", /^-?[\d.,]+(E[+-]?\d+)?$/i.test(row.values[c] ?? "") && "text-right tabular-nums")} title={row.values[c]}>
                      {row.values[c]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {current.truncated && <p className="p-3 text-xs text-muted-foreground">Aperçu limité aux 1 000 premières lignes et 60 premières colonnes. Téléchargez le fichier pour la totalité.</p>}
        </div>
      )}
      <p className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">Valeurs enregistrées dans le fichier : les formules ne sont pas recalculées et la mise en forme n’est pas reproduite.</p>
    </div>
  );
}

/** Présentation : texte de chaque diapositive (pas de rendu graphique fidèle sans suite bureautique). */
export function PptxViewer({ file }: ViewerProps) {
  const { state, reload } = usePreview(file, "pptx");
  if (!state) return <Loading />;
  if ("error" in state) return <ErrorNotice message={state.error} onRetry={reload} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <span className="flex-1 text-xs text-muted-foreground">{state.data.slides.length} diapositive{state.data.slides.length > 1 ? "s" : ""} · aperçu du texte, sans la mise en page</span>
        <ReadOnlyNote>Lecture seule</ReadOnlyNote>
      </ViewerToolbar>
      <ol className="min-h-0 flex-1 space-y-3 overflow-auto bg-muted/50 p-4">
        {state.data.slides.map((s) => (
          <li key={s.number} className="mx-auto max-w-3xl rounded-xl bg-background p-4 shadow-sm ring-1 ring-border/60">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Diapositive {s.number}</p>
            <div className="text-sm leading-6 whitespace-pre-wrap">{s.text.replace(/^# /gm, "").trim() || <span className="text-muted-foreground">Aucun texte.</span>}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
