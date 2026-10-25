"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Eye, Info, Lock, Pencil, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DocxBlock } from "@/lib/files/docx-text";
import { cn } from "@/lib/utils";
import { contentUrl, ErrorNotice, Loading, SaveStatus, useSaver, useSaveShortcut, ViewerToolbar, type ViewerProps } from "./common";
import { usePreview } from "./office-viewers";

/**
 * Document Word : aperçu fidèle (mise en page, styles, tableaux, images, en-têtes) rendu dans le navigateur par
 * docx-preview, et modification du TEXTE des paragraphes enregistrée dans le .docx lui-même (rien n'est converti).
 */
export function DocxViewer(props: ViewerProps) {
  const [tab, setTab] = useState<"preview" | "edit">("preview");
  const onSaved = useCallback(
    (saved: Parameters<ViewerProps["onSaved"]>[0]) => {
      props.onSaved(saved);
      setTab("preview"); // le rendu de la nouvelle version permet de vérifier le résultat
    },
    [props],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <div className="flex rounded-full bg-muted p-0.5 text-xs" role="tablist" aria-label="Mode">
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
              {t === "preview" ? "Aperçu" : "Modifier le texte"}
            </button>
          ))}
        </div>
      </ViewerToolbar>
      {/* L'éditeur reste monté quand on revient à l'aperçu : les modifications en cours ne sont pas perdues. */}
      <div className={cn("min-h-0 flex-1 flex-col", tab === "preview" ? "flex" : "hidden")}>
        <DocxPreview file={props.file} />
      </div>
      <div className={cn("min-h-0 flex-1 flex-col", tab === "edit" ? "flex" : "hidden")}>
        <DocxTextEditor {...props} onSaved={onSaved} />
      </div>
    </div>
  );
}

/** Neutralise les liens du document (javascript:, data:…) : seuls http(s) et mailto restent, ouverts à part. */
function sanitizeLinks(root: HTMLElement) {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
    } else a.removeAttribute("href");
  }
}

/** Pages plus larges que le panneau (tablette, mobile) : réduites pour tenir en largeur, comme une visionneuse. */
function fitPages(host: HTMLElement) {
  const wrapper = host.querySelector<HTMLElement>(".docx-wrapper");
  const page = wrapper?.querySelector<HTMLElement>("section.docx");
  if (!wrapper || !page) return;
  const available = host.clientWidth - 32;
  const width = page.offsetWidth;
  wrapper.style.zoom = width > available && available > 0 ? String(Math.max(0.3, available / width)) : "";
}

function DocxPreview({ file }: { file: ViewerProps["file"] }) {
  const body = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = body.current;
    if (!host) return;
    const ro = new ResizeObserver(() => fitPages(host));
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  const [state, setState] = useState<{ version: number; status: "ready" } | { version: number; error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(contentUrl(file));
        if (!res.ok) throw new Error(res.status === 404 ? "Fichier introuvable." : `Lecture impossible (${res.status}).`);
        const blob = await res.blob();
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !body.current || !styles.current) return;
        body.current.replaceChildren();
        styles.current.replaceChildren();
        await renderAsync(blob, body.current, styles.current, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderChanges: false,
          renderComments: false,
          // Morceaux HTML intégrés (altChunk) : jamais rendus dans l'origine de l'application.
          renderAltChunks: false,
          useBase64URL: false,
        });
        sanitizeLinks(body.current);
        fitPages(body.current);
        // Puces Word dessinées avec la police Symbol (absente hors Windows / macOS) : caractères Unicode équivalents.
        for (const style of styles.current.querySelectorAll("style")) {
          style.textContent = (style.textContent ?? "").replace(/\uF0B7/g, "\u2022").replace(/\uF0A7/g, "\u25AA").replace(/\uF0D8/g, "\u27A2").replace(/\uF076/g, "\u2756").replace(/\uF0FC/g, "\u2714");
        }
        if (!cancelled) setState({ version: file.version, status: "ready" });
      } catch (err) {
        if (!cancelled) setState({ version: file.version, error: err instanceof Error && err.message.startsWith("Lecture") ? err.message : "Ce document Word n’a pas pu être affiché (fichier corrompu ou fonctionnalité non prise en charge). Le mode « Modifier le texte » et le téléchargement restent disponibles." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);
  const current = state?.version === file.version ? state : null;
  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-muted/60">
      {!current && <Loading label="Mise en page du document…" />}
      {current && "error" in current && <ErrorNotice message={current.error} />}
      <div ref={styles} />
      {/* Pages blanches sur fond neutre, comme un traitement de texte, dans les deux thèmes. */}
      <div ref={body} className="docx-host text-black [&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-4 [&_.docx-wrapper>section.docx]:!mb-4 [&_.docx-wrapper>section.docx]:shadow-sm" />
    </div>
  );
}

const HEADING_CLASSES = ["text-2xl font-semibold", "text-xl font-semibold", "text-lg font-semibold", "text-base font-semibold", "text-[0.95rem] font-semibold"];

function fit(el: HTMLTextAreaElement) {
  // Masqué (onglet Aperçu) : aucune mesure possible ; la hauteur naturelle d'une ligne est conservée.
  if (!el.offsetParent) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function AutoTextarea({ value, onChange, className, label }: { value: string; onChange: (v: string) => void; className?: string; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [value]);
  // Monté masqué (onglet Aperçu) : hauteur nulle tant qu'il est invisible, recalculée dès qu'il s'affiche
  // ou que sa largeur change (redimensionnement du panneau).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit(el);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className={cn("block w-full resize-none overflow-hidden rounded-md bg-transparent px-2 py-1 outline-none hover:bg-muted/60 focus:bg-muted focus:ring-1 focus:ring-ring", className)}
    />
  );
}

type Group = { kind: "p"; block: DocxBlock } | { kind: "table"; rows: DocxBlock[][][] };

function groupBlocks(blocks: DocxBlock[]): Group[] {
  const groups: Group[] = [];
  for (const b of blocks) {
    if (!b.table) {
      groups.push({ kind: "p", block: b });
      continue;
    }
    let last = groups.at(-1);
    if (!last || last.kind !== "table" || last.rows[0]?.[0]?.[0]?.table?.table !== b.table.table) {
      last = { kind: "table", rows: [] };
      groups.push(last);
    }
    const rows = (last as Extract<Group, { kind: "table" }>).rows;
    rows[b.table.row] ??= [];
    rows[b.table.row][b.table.cell] ??= [];
    rows[b.table.row][b.table.cell].push(b);
  }
  return groups;
}

function DocxTextEditor(props: ViewerProps) {
  const { state, reload } = usePreview(props.file, "docx");
  if (!state) return <Loading />;
  if ("error" in state) return <ErrorNotice message={state.error} onRetry={reload} />;
  return <DocxTextEditorBody key={props.file.version} {...props} blocks={state.data.blocks} />;
}

function DocxTextEditorBody({ file, onSaved, onDirtyChange, blocks }: ViewerProps & { blocks: DocxBlock[] }) {
  const [edits, setEdits] = useState<Record<number, string>>({});
  const { state: saveState, save } = useSaver(file, onSaved);
  const changed = useMemo(() => Object.entries(edits).filter(([i, text]) => blocks[Number(i)]?.text !== text), [edits, blocks]);
  const dirty = changed.length > 0;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  const readOnlyCount = blocks.filter((b) => !b.editable && b.text.trim()).length;

  const doSave = useCallback(() => {
    if (dirty && saveState.status !== "saving") void save({ edits: changed.map(([i, text]) => ({ index: Number(i), text })) });
  }, [dirty, saveState.status, save, changed]);
  useSaveShortcut(doSave, dirty);

  const paragraph = (b: DocxBlock, inCell = false) => {
    const value = edits[b.index] ?? b.text;
    const headingClass = b.heading !== null ? HEADING_CLASSES[Math.min(b.heading, HEADING_CLASSES.length - 1)] : inCell ? "text-sm" : "text-[0.95rem] leading-7";
    if (!b.editable) {
      if (!b.text.trim()) return null;
      return (
        <p key={b.index} className={cn("flex items-start gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-muted-foreground", headingClass)} title={`Lecture seule : ce paragraphe ${b.reason}.`}>
          <Lock className="mt-1.5 size-3 shrink-0" aria-label={`Lecture seule : ce paragraphe ${b.reason}`} />
          <span className="whitespace-pre-wrap">{b.text}</span>
        </p>
      );
    }
    const modified = value !== b.text;
    return (
      <div key={b.index} className={cn("relative", b.list && "flex items-start gap-1 pl-3")}>
        {b.list && <span className="mt-1 text-muted-foreground" aria-hidden>•</span>}
        <div className="min-w-0 flex-1">
          <AutoTextarea
            value={value}
            label={b.heading !== null ? `Titre de niveau ${b.heading || 1}` : `Paragraphe ${b.index + 1}`}
            onChange={(v) => setEdits((e) => ({ ...e, [b.index]: v }))}
            className={cn(headingClass, !value && "min-h-6", modified && "bg-warning/10")}
          />
          {modified && b.mixedFormatting && (
            <p className="flex items-center gap-1 px-2 text-[0.7rem] text-warning-foreground">
              <AlertTriangle className="size-3" /> Mise en forme mixte : ce paragraphe prendra la mise en forme de son début.
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <div className="min-w-0 flex-1 px-1">
          <SaveStatus state={saveState} dirty={dirty} />
          {!dirty && saveState.status === "idle" && <span className="text-xs text-muted-foreground">Cliquez dans un paragraphe pour le modifier.</span>}
        </div>
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setEdits({})}>
            Annuler les modifications
          </Button>
        )}
        <Button type="button" size="sm" onClick={doSave} disabled={!dirty || saveState.status === "saving"} title="Enregistrer (Ctrl + S)">
          <Save /> Enregistrer{dirty ? ` (${changed.length})` : ""}
        </Button>
      </ViewerToolbar>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/40 px-3 py-4">
        <div className="mx-auto max-w-3xl space-y-0.5 rounded-xl bg-background px-4 py-5 shadow-sm ring-1 ring-border/60 sm:px-8">
          <p className="mb-3 flex items-start gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Modification du texte, enregistrée dans le fichier Word : mise en page, styles, tableaux, images, en-têtes et paragraphes non modifiés sont conservés.
              Ajouter ou supprimer des paragraphes, changer la mise en forme ou insérer des images nécessite un traitement de texte (téléchargez le fichier).
              {readOnlyCount > 0 && ` ${readOnlyCount} paragraphe${readOnlyCount > 1 ? "s" : ""} (liens, champs, révisions, zones de texte…) ${readOnlyCount > 1 ? "sont" : "est"} en lecture seule.`}
            </span>
          </p>
          {groups.map((g, gi) =>
            g.kind === "p" ? (
              paragraph(g.block)
            ) : (
              <div key={`t${gi}`} className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {g.rows.map((row, r) => (
                      <tr key={r}>
                        {(row ?? []).map((cell, c) => (
                          <td key={c} className="border border-border p-1 align-top">
                            {(cell ?? []).map((b) => paragraph(b, true))}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          )}
          {!blocks.length && <p className="text-sm text-muted-foreground">Ce document ne contient aucun paragraphe.</p>}
        </div>
      </div>
    </div>
  );
}
