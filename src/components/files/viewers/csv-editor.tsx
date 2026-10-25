"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Columns3, Rows3, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseCsvTable, serializeCsv, type CsvTable } from "@/lib/files/csv";
import { ErrorNotice, Loading, SaveStatus, useFileText, useSaver, useSaveShortcut, ViewerToolbar, type ViewerProps } from "./common";

const PAGE = 200;

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const DELIMITERS: Record<string, string> = { ",": "virgule", ";": "point-virgule", "\t": "tabulation", "|": "barre verticale" };

/** Tableau CSV éditable : cellules, ajout / suppression de lignes et de colonnes, séparateur d'origine conservé. */
export function CsvEditor(props: ViewerProps) {
  const { state, reload } = useFileText(props.file);
  if (!state) return <Loading />;
  if ("error" in state) return <ErrorNotice message={state.error} onRetry={reload} />;
  return <CsvEditorBody key={props.file.version} {...props} original={state.text} />;
}

function CsvEditorBody({ file, onSaved, onDirtyChange, original }: ViewerProps & { original: string }) {
  const initial = useMemo(() => parseCsvTable(original), [original]);
  const [table, setTable] = useState<CsvTable>(initial);
  const [shown, setShown] = useState(PAGE);
  const { state: saveState, save } = useSaver(file, onSaved);
  const serialized = useMemo(() => serializeCsv(table), [table]);
  const dirty = serialized !== serializeCsv(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const width = Math.max(1, ...table.rows.map((r) => r.length));

  const doSave = useCallback(() => {
    if (dirty && saveState.status !== "saving") void save({ text: serialized });
  }, [dirty, saveState.status, save, serialized]);
  useSaveShortcut(doSave, dirty);

  const setCell = (r: number, c: number, value: string) =>
    setTable((t) => ({ ...t, rows: t.rows.map((row, i) => (i === r ? Array.from({ length: Math.max(row.length, c + 1) }, (_, k) => (k === c ? value : (row[k] ?? ""))) : row)) }));
  const addRow = () => {
    setTable((t) => ({ ...t, rows: [...t.rows, Array(width).fill("")] }));
    setShown((s) => Math.max(s, table.rows.length + 1));
  };
  const addColumn = () => setTable((t) => ({ ...t, rows: t.rows.length ? t.rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill(""), ""]) : [[""]] }));
  const removeRow = (r: number) => setTable((t) => ({ ...t, rows: t.rows.filter((_, i) => i !== r) }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <Button type="button" variant="ghost" size="sm" onClick={addRow}>
          <Rows3 /> Ligne
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={addColumn}>
          <Columns3 /> Colonne
        </Button>
        <span className="hidden px-1 text-xs text-muted-foreground sm:inline">
          {table.rows.length} ligne{table.rows.length > 1 ? "s" : ""} · séparateur : {DELIMITERS[table.delimiter] ?? table.delimiter}
        </span>
        <div className="min-w-0 flex-1 px-1">
          <SaveStatus state={saveState} dirty={dirty} />
        </div>
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setTable(initial)}>
            Annuler les modifications
          </Button>
        )}
        <Button type="button" size="sm" onClick={doSave} disabled={!dirty || saveState.status === "saving"} title="Enregistrer (Ctrl + S)">
          <Save /> Enregistrer
        </Button>
      </ViewerToolbar>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="sticky left-0 z-10 w-10 border-r border-b border-border bg-muted" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} scope="col" className="min-w-28 border-r border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
                  {colName(c)}
                </th>
              ))}
              <th className="w-9 border-b border-border" />
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, shown).map((row, r) => (
              <tr key={r} className="group/row">
                <th scope="row" className="sticky left-0 border-r border-b border-border bg-muted px-2 text-right font-normal text-muted-foreground tabular-nums">
                  {r + 1}
                </th>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} className="border-r border-b border-border p-0">
                    <input
                      value={row[c] ?? ""}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      aria-label={`Ligne ${r + 1}, colonne ${colName(c)}`}
                      className={`block w-full min-w-28 bg-transparent px-2 py-1.5 outline-none focus:bg-accent focus:ring-1 focus:ring-ring ${r === 0 ? "font-medium" : ""}`}
                    />
                  </td>
                ))}
                <td className="border-b border-border px-1">
                  <Button type="button" variant="ghost" size="icon-xs" className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" onClick={() => removeRow(r)} aria-label={`Supprimer la ligne ${r + 1}`}>
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length > shown && (
          <div className="p-3">
            <Button type="button" variant="outline" size="sm" onClick={() => setShown((s) => s + PAGE)}>
              Afficher {Math.min(PAGE, table.rows.length - shown)} lignes de plus ({table.rows.length - shown} restantes)
            </Button>
          </div>
        )}
        {!table.rows.length && <p className="p-6 text-sm text-muted-foreground">Fichier vide : ajoutez une ligne pour commencer.</p>}
      </div>
    </div>
  );
}
