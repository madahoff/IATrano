"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Braces, Eye, Pencil, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";
import { ErrorNotice, Loading, SaveStatus, useFileText, useSaver, useSaveShortcut, ViewerToolbar, type ViewerProps } from "./common";

function jsonError(text: string) {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "JSON invalide";
  }
}

/** Texte brut, Markdown (aperçu / édition) et JSON (validé avant l'enregistrement). */
export function TextEditor(props: ViewerProps) {
  const { state, reload } = useFileText(props.file);
  if (!state) return <Loading />;
  if ("error" in state) return <ErrorNotice message={state.error} onRetry={reload} />;
  // Éditeur recréé à chaque version enregistrée : le brouillon repart du contenu réellement sauvegardé.
  return <TextEditorBody key={props.file.version} {...props} original={state.text} />;
}

function TextEditorBody({ file, onSaved, onDirtyChange, original }: ViewerProps & { original: string }) {
  const mode = file.editMode;
  const [value, setValue] = useState(original);
  const [tab, setTab] = useState<"preview" | "edit">(mode === "markdown" ? "preview" : "edit");
  const { state: saveState, save } = useSaver(file, onSaved);
  const dirty = value !== original;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const invalid = useMemo(() => (mode === "json" ? jsonError(value) : null), [mode, value]);
  const doSave = useCallback(() => {
    if (!dirty || invalid || saveState.status === "saving") return;
    void save({ text: value });
  }, [dirty, invalid, saveState.status, save, value]);
  useSaveShortcut(doSave, dirty);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        {mode === "markdown" && (
          <div className="flex rounded-full bg-muted p-0.5 text-xs" role="tablist" aria-label="Affichage">
            {(["preview", "edit"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn("inline-flex items-center gap-1 rounded-full px-3 py-1 font-medium transition-colors", tab === t ? "bg-background shadow-sm" : "text-muted-foreground")}
              >
                {t === "preview" ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
                {t === "preview" ? "Aperçu" : "Modifier"}
              </button>
            ))}
          </div>
        )}
        {mode === "json" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={Boolean(invalid)}
            onClick={() => setValue(JSON.stringify(JSON.parse(value), null, 2) + (value.endsWith("\n") ? "\n" : ""))}
            title="Indenter le JSON"
          >
            <Braces /> Formater
          </Button>
        )}
        <div className="min-w-0 flex-1 px-1">
          {invalid ? <span className="truncate text-xs text-destructive">JSON invalide : {invalid}</span> : <SaveStatus state={saveState} dirty={dirty} />}
        </div>
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setValue(original)}>
            Annuler les modifications
          </Button>
        )}
        <Button type="button" size="sm" onClick={doSave} disabled={!dirty || Boolean(invalid) || saveState.status === "saving"} title="Enregistrer (Ctrl + S)">
          <Save /> Enregistrer
        </Button>
      </ViewerToolbar>
      {mode === "markdown" && tab === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          <div className="mx-auto max-w-3xl">
            <Markdown content={value} />
          </div>
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={mode !== "json"}
          aria-label={`Contenu de ${file.name}`}
          className="min-h-0 flex-1 resize-none bg-background px-5 py-4 font-mono text-[0.82rem] leading-6 outline-none"
        />
      )}
    </div>
  );
}
