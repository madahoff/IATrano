"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { api } from "@/lib/client/api";
import { FILE_KIND_LABELS, type ChatFileDTO, type ChatFileUpload } from "@/lib/files/types";
import { cn } from "@/lib/utils";
import { FileIcon } from "./file-icon";
import { formatFileSize } from "./file-card";
import { closeFileViewer, notifyFileSaved, restoreFocusAfterViewer, setFileViewerIndex, useFileViewer } from "./viewer-store";
import { contentUrl, ErrorNotice, errorMessage, Loading, type ViewerProps } from "./viewers/common";
import { TextEditor } from "./viewers/text-editor";
import { CsvEditor } from "./viewers/csv-editor";
import { ImageViewer } from "./viewers/image-viewer";
import { PdfViewer } from "./viewers/pdf-viewer";
import { MediaViewer } from "./viewers/media-viewer";
import { DocxViewer } from "./viewers/docx-viewer";
import { PptxViewer, XlsxViewer } from "./viewers/office-viewers";

const MIN = { w: 480, h: 360 };
const DEFAULT = { w: 1100, h: 860 };

function parseSize(pref: string | null) {
  try {
    const s = pref ? (JSON.parse(pref) as { w: number; h: number }) : null;
    return s && s.w >= MIN.w && s.h >= MIN.h ? s : null;
  } catch {
    return null;
  }
}

function IconButton({ label, onClick, children, disabled }: { label: string; onClick?: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onClick} aria-label={label} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function FileBody(props: ViewerProps) {
  switch (props.file.kind) {
    case "PDF":
      return <PdfViewer {...props} />;
    case "IMAGE":
      return <ImageViewer {...props} />;
    case "DOCX":
      return <DocxViewer {...props} />;
    case "TEXT":
    case "MARKDOWN":
    case "JSON":
      return <TextEditor {...props} />;
    case "CSV":
      return <CsvEditor {...props} />;
    case "XLSX":
      return <XlsxViewer {...props} />;
    case "PPTX":
      return <PptxViewer {...props} />;
    case "VIDEO":
    case "AUDIO":
      return <MediaViewer {...props} />;
    default:
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
          <FileIcon kind={props.file.kind} className="size-10" />
          <p>Aucun aperçu n’est disponible pour ce format dans l’application.</p>
          <Button asChild variant="outline" size="sm">
            <a href={contentUrl(props.file, true)}>
              <Download /> Télécharger
            </a>
          </Button>
        </div>
      );
  }
}

/**
 * Panneau d'aperçu et d'édition des fichiers joints, au-dessus de toute l'application (portail Radix : focus
 * piégé, Échap, retour du focus à l'élément d'origine). La conversation et la zone de saisie restent intactes.
 */
export function FileViewer() {
  const { open, files, index } = useFileViewer();
  const current = files[index];
  const [dto, setDto] = useState<{ id: string; file: ChatFileDTO } | { id: string; error: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [sizePref, setSizePref] = useLocalStorage("iatrano:file-viewer-size");
  // Taille pendant un redimensionnement à la souris ; sinon, la préférence enregistrée.
  const [dragSize, setDragSize] = useState<{ w: number; h: number } | null>(null);
  const size = dragSize ?? parseSize(sizePref) ?? DEFAULT;
  const contentRef = useRef<HTMLDivElement>(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || !current) return;
    let cancelled = false;
    const id = current.id;
    api<ChatFileDTO>(`/api/chat/files/${id}`)
      .then((file) => !cancelled && setDto({ id, file }))
      .catch((err) => !cancelled && setDto({ id, error: errorMessage(err, "Fichier indisponible : vérifiez votre connexion.") }));
    return () => {
      cancelled = true;
    };
  }, [open, current, attempt]);

  /** Exécute l'action tout de suite, ou après confirmation si des modifications ne sont pas enregistrées. */
  const guard = useCallback((action: () => void) => (dirty ? setPending(() => action) : action()), [dirty]);
  const close = useCallback(() => guard(closeFileViewer), [guard]);

  const onSaved = useCallback((saved: ChatFileUpload) => {
    const { text: _text, ...file } = saved;
    void _text;
    setDto({ id: saved.id, file });
    setDirty(false);
    notifyFileSaved(saved);
  }, []);

  // Redimensionnement (ordinateur) : poignée en bas à droite, ou flèches du clavier sur la poignée.
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const resizeLast = useRef<{ w: number; h: number } | null>(null);
  const clamp = (w: number, h: number) => ({
    w: Math.round(Math.min(Math.max(w, MIN.w), window.innerWidth - 16)),
    h: Math.round(Math.min(Math.max(h, MIN.h), window.innerHeight - 16)),
  });
  const commitSize = (s: { w: number; h: number }) => {
    setSizePref(JSON.stringify(s));
    setDragSize(null);
  };

  const meta = dto && "file" in dto ? dto.file : null;
  const loadingFile = !dto || dto.id !== current?.id;

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && close()}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <DialogPrimitive.Content
            ref={contentRef}
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => {
              if (dirty) {
                e.preventDefault();
                close();
              }
            }}
            onOpenAutoFocus={(e) => {
              // Focus sur le panneau lui-même (et non sur son premier bouton, dont l'infobulle s'ouvrirait).
              e.preventDefault();
              contentRef.current?.focus();
            }}
            onCloseAutoFocus={(e) => {
              // Ouvert sans déclencheur Radix : le focus revient explicitement à la carte d'origine.
              e.preventDefault();
              restoreFocusAfterViewer();
            }}
            onPointerDownOutside={(e) => {
              if (dirty) {
                e.preventDefault();
                close();
              }
            }}
            style={{ "--fv-w": `${size.w}px`, "--fv-h": `${size.h}px` } as React.CSSProperties}
            className={cn(
              "fixed inset-2 z-50 flex flex-col overflow-hidden rounded-2xl bg-background text-foreground shadow-2xl ring-1 ring-border outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none",
              maximized
                ? "sm:inset-3"
                : "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(var(--fv-h),calc(100dvh-2rem))] sm:w-[min(var(--fv-w),calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2",
            )}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
              {current && <FileIcon kind={meta?.kind ?? current.kind} className="size-5" />}
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="truncate text-sm font-semibold">{meta?.name ?? current?.name ?? "Fichier"}</DialogPrimitive.Title>
                <p className="truncate text-xs text-muted-foreground tabular-nums">
                  {meta ? (
                    <>
                      {FILE_KIND_LABELS[meta.kind]} · {formatFileSize(meta.sizeBytes)}
                      {meta.pageCount ? ` · ${meta.pageCount} page${meta.pageCount > 1 ? "s" : ""}` : ""}
                      {meta.version > 1 ? ` · version ${meta.version}` : ""}
                      {meta.editMode ? " · modifiable" : " · lecture seule"}
                      {dirty && <span className="text-warning-foreground"> · non enregistré</span>}
                    </>
                  ) : (
                    " "
                  )}
                </p>
              </div>
              {files.length > 1 && (
                <div className="flex items-center" role="group" aria-label="Fichiers joints">
                  <IconButton label="Fichier précédent" onClick={() => guard(() => setFileViewerIndex(index - 1))} disabled={index === 0}>
                    <ChevronLeft />
                  </IconButton>
                  <span className="px-0.5 text-xs text-muted-foreground tabular-nums">
                    {index + 1} / {files.length}
                  </span>
                  <IconButton label="Fichier suivant" onClick={() => guard(() => setFileViewerIndex(index + 1))} disabled={index === files.length - 1}>
                    <ChevronRight />
                  </IconButton>
                </div>
              )}
              {meta && (
                <>
                  {(meta.kind === "PDF" || meta.kind === "IMAGE") && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button asChild variant="ghost" size="icon-sm" className="hidden text-muted-foreground sm:inline-flex">
                          <a href={contentUrl(meta)} target="_blank" rel="noopener" aria-label="Ouvrir dans un nouvel onglet">
                            <ExternalLink />
                          </a>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Ouvrir dans un nouvel onglet</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
                        <a href={contentUrl(meta, true)} aria-label="Télécharger" download>
                          <Download />
                        </a>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{dirty ? "Télécharger (dernière version enregistrée)" : "Télécharger"}</TooltipContent>
                  </Tooltip>
                </>
              )}
              <span className="hidden sm:inline-flex">
                <IconButton label={maximized ? "Réduire" : "Agrandir"} onClick={() => setMaximized((m) => !m)}>
                  {maximized ? <Minimize2 /> : <Maximize2 />}
                </IconButton>
              </span>
              <IconButton label="Fermer (Échap)" onClick={close}>
                <X />
              </IconButton>
            </header>

            <div className="flex min-h-0 flex-1 flex-col">
              {loadingFile ? (
                <Loading />
              ) : "error" in dto ? (
                <ErrorNotice message={dto.error} onRetry={() => setAttempt((n) => n + 1)} />
              ) : (
                <FileBody key={dto.file.id} file={dto.file} onSaved={onSaved} onDirtyChange={setDirty} />
              )}
              {meta?.sent && meta.editMode && (
                <p className="shrink-0 border-t border-border px-3 py-1 text-[0.7rem] text-muted-foreground">
                  Fichier déjà envoyé : les messages précédents gardent le texte d’origine ; joignez-le à nouveau pour que l’IA lise la nouvelle version.
                </p>
              )}
            </div>

            {!maximized && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Redimensionner le panneau (flèches du clavier)"
                tabIndex={0}
                // Dans la partie visible du coin arrondi (le panneau masque ce qui dépasse de son rayon).
                className="absolute right-1 bottom-1 hidden size-5 cursor-nwse-resize touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex sm:items-end sm:justify-end"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const rect = contentRef.current?.getBoundingClientRect();
                  resizeStart.current = { x: e.clientX, y: e.clientY, w: rect?.width ?? size.w, h: rect?.height ?? size.h };
                  resizeLast.current = null;
                }}
                onPointerMove={(e) => {
                  const s = resizeStart.current;
                  if (!s) return;
                  // Panneau centré : il grandit des deux côtés, d'où le facteur 2.
                  resizeLast.current = clamp(s.w + 2 * (e.clientX - s.x), s.h + 2 * (e.clientY - s.y));
                  setDragSize(resizeLast.current);
                }}
                onPointerUp={() => {
                  if (resizeLast.current) commitSize(resizeLast.current);
                  resizeStart.current = null;
                  resizeLast.current = null;
                }}
                onKeyDown={(e) => {
                  const d = { ArrowRight: [40, 0], ArrowLeft: [-40, 0], ArrowDown: [0, 40], ArrowUp: [0, -40] }[e.key];
                  if (!d) return;
                  e.preventDefault();
                  commitSize(clamp(size.w + d[0], size.h + d[1]));
                }}
              >
                <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground/60" aria-hidden>
                  <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Modifications non enregistrées</AlertDialogTitle>
            <AlertDialogDescription>Si vous quittez ce fichier maintenant, les modifications en cours seront perdues.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuer l’édition</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const action = pending;
                setPending(null);
                setDirty(false);
                action?.();
              }}
            >
              Quitter sans enregistrer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
