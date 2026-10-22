"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Info, Loader2, Maximize2, Minimize2, RotateCcw, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/common/copy-button";
import { api, ApiError } from "@/lib/client/api";
import { ARTIFACT_SANDBOX, buildDownloadDocument, buildSandboxDocument, isBridgeMessage } from "@/lib/artifacts/sandbox";
import type { ArtifactDTO } from "@/lib/artifacts/types";
import { cn } from "@/lib/utils";

const ORIGIN_LABELS: Record<ArtifactDTO["origin"], string> = { GENERATED: "créée", EDITED: "modifiée", REPAIRED: "corrigée" };

function slug(title: string) {
  return (
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "page-interactive"
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Panneau « artifacts » : aperçu isolé (iframe sandbox), code, versions v1 / v2 / v3, copie, téléchargement.
 * Une erreur JavaScript ou une page invalide déclenche UNE correction automatique ; ensuite, bouton manuel.
 */
export function ArtifactPanel({
  artifactId,
  expanded,
  onToggleExpand,
  onClose,
  onLoaded,
  onNewVersion,
}: {
  artifactId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onLoaded: (a: ArtifactDTO) => void;
  onNewVersion: (a: ArtifactDTO) => void;
}) {
  const [currentId, setCurrentId] = useState(artifactId);
  const [dto, setDto] = useState<ArtifactDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [errors, setErrors] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(0);
  const [repairing, setRepairing] = useState<null | "auto" | "manual">(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const autoTried = useRef(new Set<string>());
  const callbacks = useRef({ onLoaded, onNewVersion });
  useEffect(() => {
    callbacks.current = { onLoaded, onNewVersion };
  });

  // Ouverture d'un autre artifact depuis le fil.
  const [prevProp, setPrevProp] = useState(artifactId);
  if (prevProp !== artifactId) {
    setPrevProp(artifactId);
    setCurrentId(artifactId);
  }

  useEffect(() => {
    let cancelled = false;
    api<{ artifact: ArtifactDTO }>(`/api/artifacts/${currentId}`)
      .then(({ artifact }) => {
        if (cancelled) return;
        setDto(artifact);
        setLoadError(null);
        setErrors([]);
        setBlocked(0);
        setRepairError(null);
        callbacks.current.onLoaded(artifact);
      })
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err.message : "Chargement impossible."));
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  // Messages du pont injecté dans l'aperçu : seules les fenêtres de CET iframe sont écoutées.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow || !isBridgeMessage(e.data)) return;
      if (e.data.type === "error") {
        const line = e.data.detail.line ? ` (ligne ${e.data.detail.line})` : "";
        const msg = `${String(e.data.detail.message ?? "Erreur JavaScript").slice(0, 300)}${line}`;
        setErrors((prev) => (prev.includes(msg) || prev.length >= 5 ? prev : [...prev, msg]));
      } else if (e.data.type === "blocked") {
        setBlocked((n) => n + 1);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const latestVersion = dto ? Math.max(...dto.versions.map((v) => v.version)) : 0;
  const isLatest = dto ? dto.version === latestVersion : false;
  const problem = dto ? (errors.length ? `Erreur JavaScript : ${errors.join(" | ")}` : !dto.valid ? dto.issues.join(" ") : null) : null;

  const repair = useCallback(
    async (auto: boolean) => {
      if (!dto || !problem) return;
      setRepairing(auto ? "auto" : "manual");
      setRepairError(null);
      try {
        const { artifact } = await api<{ artifact: ArtifactDTO }>(`/api/artifacts/${dto.id}/repair`, { method: "POST", json: { problem, auto } });
        setCurrentId(artifact.id);
        setDto(artifact);
        setErrors([]);
        setBlocked(0);
        callbacks.current.onNewVersion(artifact);
      } catch (err) {
        setRepairError(err instanceof ApiError ? err.message : "Correction impossible.");
      } finally {
        setRepairing(null);
      }
    },
    [dto, problem],
  );

  // Une seule tentative automatique par version (la limite est aussi imposée par le serveur).
  useEffect(() => {
    if (!dto || !problem || !isLatest || dto.autoRepairUsed || repairing || autoTried.current.has(dto.id)) return;
    const t = setTimeout(() => {
      autoTried.current.add(dto.id);
      void repair(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [dto, problem, isLatest, repairing, repair]);

  const srcDoc = useMemo(() => (dto ? buildSandboxDocument(dto.code) : ""), [dto]);

  function download() {
    if (!dto) return;
    const blob = new Blob([buildDownloadDocument(dto.code, dto.title)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(dto.title)}-v${dto.version}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section aria-label="Page interactive" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{dto?.title ?? "Page interactive"}</h2>
          {dto && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1" role="group" aria-label="Versions">
              {dto.versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setCurrentId(v.id)}
                  aria-current={v.id === dto.id ? "true" : undefined}
                  title={`Version ${v.version} ${ORIGIN_LABELS[v.origin]} le ${new Date(v.createdAt).toLocaleString("fr-FR")}`}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs tabular-nums transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    v.id === dto.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                    !v.valid && v.id !== dto.id && "text-warning-foreground",
                  )}
                >
                  v{v.version}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex rounded-full bg-muted p-0.5 text-xs" role="tablist" aria-label="Affichage">
          {(["preview", "code"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("rounded-full px-3 py-1 font-medium transition-colors", tab === t ? "bg-background shadow-sm" : "text-muted-foreground")}
            >
              {t === "preview" ? "Aperçu" : "Code"}
            </button>
          ))}
        </div>
        <span className="hidden md:inline-flex">
          <IconButton label={expanded ? "Réduire" : "Agrandir"} onClick={onToggleExpand}>
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </span>
        {dto && <CopyButton text={dto.code} label="Copier le code" />}
        <IconButton label="Télécharger le .html" onClick={download}>
          <Download />
        </IconButton>
        <IconButton label="Fermer" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      {loadError && <p className="m-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{loadError}</p>}
      {!dto && !loadError && (
        <p className="m-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Chargement…
        </p>
      )}

      {dto && (problem || repairing || repairError) && (
        <div role="alert" className="mx-3 mt-3 rounded-2xl bg-warning/15 px-4 py-3 text-sm">
          {repairing ? (
            <p className="flex items-center gap-2 font-medium">
              <Loader2 className="size-4 animate-spin" />
              {repairing === "auto" ? "Erreur détectée : correction automatique par Qwen…" : "Correction en cours par Qwen…"}
            </p>
          ) : (
            <>
              <p className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                {errors.length ? "Cette page a rencontré une erreur." : "Cette page ne peut pas s'afficher correctement."}
              </p>
              {problem && (
                <details className="mt-1 pl-6 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Détails</summary>
                  <p className="mt-1 break-words">{problem}</p>
                </details>
              )}
              {repairError && <p className="mt-1 pl-6 text-xs text-destructive">{repairError}</p>}
              {problem && isLatest && (
                <div className="mt-2 pl-6">
                  <Button size="sm" variant="secondary" onClick={() => void repair(false)}>
                    <RotateCcw /> Régénérer l&apos;artifact
                  </Button>
                  {dto.autoRepairUsed && <span className="ml-2 text-xs text-muted-foreground">La correction automatique a déjà été tentée.</span>}
                </div>
              )}
              {problem && !isLatest && <p className="mt-1 pl-6 text-xs text-muted-foreground">Une version plus récente existe : sélectionnez-la ci-dessus.</p>}
            </>
          )}
        </div>
      )}

      {dto && (
        <div className="relative min-h-0 flex-1 p-3">
          {tab === "preview" ? (
            <iframe
              ref={iframeRef}
              key={dto.id}
              title={`Aperçu : ${dto.title}`}
              sandbox={ARTIFACT_SANDBOX}
              srcDoc={srcDoc}
              referrerPolicy="no-referrer"
              allow=""
              className="h-full w-full rounded-2xl border border-border bg-white"
            />
          ) : (
            <pre className="h-full overflow-auto rounded-2xl bg-code p-4 font-mono text-xs leading-5 whitespace-pre text-foreground">
              <code>{dto.code}</code>
            </pre>
          )}
        </div>
      )}

      {dto && (
        <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3.5" /> Aperçu isolé : aucun accès au réseau, aux cookies ni à IATrano.
          </span>
          {blocked > 0 && <span>{blocked} ressource(s) externe(s) bloquée(s).</span>}
          {dto.issues.length > 0 && dto.valid && (
            <span className="inline-flex items-center gap-1" title={dto.issues.join("\n")}>
              <Info className="size-3.5" /> {dto.issues[0]}
            </span>
          )}
        </footer>
      )}
    </section>
  );
}
