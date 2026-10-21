"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronRight, FileText, Loader2, Minimize2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PART_LABELS, type ContextParts, type ContextState, type ContextUsageDTO, type SummaryDTO } from "@/lib/context/types";
import { WINDOW_SOURCE_LABELS } from "@/lib/context/window";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmt, type CompactionResultView, type ContextView } from "./use-context-usage";

const STATE_LABELS: Record<ContextState, string> = {
  normal: "Normal",
  warn: "Proche de la limite",
  high: "Réduction conseillée",
  critical: "Limite atteinte",
};

const RING_COLOR: Record<ContextState, string> = {
  normal: "stroke-context",
  warn: "stroke-context",
  high: "stroke-warning",
  critical: "stroke-destructive",
};

/** Cercle de progression : bleu, fond discret, animation douce ; orange puis rouge près de la limite. */
export function ContextRing({ percent, state, size = 22 }: { percent: number; state: ContextState; size?: number }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-context-track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p / 100)}
        className={cn("transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none", RING_COLOR[state])}
      />
    </svg>
  );
}

type Props = {
  view: ContextView | null;
  usage: ContextUsageDTO | null;
  error: string | null;
  loading: boolean;
  compacting: boolean;
  lastResult: CompactionResultView;
  canCompact: boolean;
  busy: boolean;
  onCompact: () => void;
  onRefresh: () => void;
};

export function ContextIndicator(props: Props) {
  const { view } = props;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"details" | "summary">("details");
  const pct = view ? Math.round(view.percent) : null;
  const label = view
    ? `Contexte utilisé : ${pct} %${view.live ? " (génération en cours)" : ""}. Afficher les détails du contexte`
    : "Contexte : calcul en cours. Afficher les détails";

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setPage("details");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted",
            view?.state === "high" && "text-warning-foreground",
            view?.state === "critical" && "text-destructive",
          )}
        >
          {props.compacting ? (
            <Loader2 className="size-[22px] animate-spin text-context" aria-hidden />
          ) : (
            <ContextRing percent={view?.percent ?? 0} state={view?.state ?? "normal"} />
          )}
          <span className="min-w-[2.6ch]">{pct === null ? "…" : `${pct} %`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="max-h-[min(75dvh,38rem)] w-[min(23rem,calc(100vw-1.5rem))] gap-3 overflow-y-auto p-4"
      >
        {page === "details" ? <Details {...props} onShowSummary={() => setPage("summary")} /> : <SummaryPage {...props} onBack={() => setPage("details")} />}
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">
        {value}
        {hint && <span className="block text-xs font-normal text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}

function Details(props: Props & { onShowSummary: () => void }) {
  const { usage, view, error } = props;
  if (!usage || !view) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-semibold">Contexte</p>
        {error ? <p className="text-destructive">{error}</p> : <Loader2 className="animate-spin text-muted-foreground" />}
        {error && (
          <Button variant="secondary" size="sm" className="w-fit" onClick={props.onRefresh}>
            <RefreshCw /> Réessayer
          </Button>
        )}
      </div>
    );
  }
  const remaining = view.capacity - view.used;
  const parts = (Object.keys(PART_LABELS) as Array<keyof ContextParts>).filter((k) => usage.parts[k] > 0);
  const total = Math.max(1, parts.reduce((n, k) => n + usage.parts[k], 0));
  const cal = usage.calibration;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">Contexte de la conversation</p>
        <Badge variant={view.state === "normal" ? "secondary" : view.state === "warn" ? "outline" : view.state === "high" ? "warning" : "destructive"}>
          {STATE_LABELS[view.state]}
        </Badge>
      </div>

      <div className="flex items-center gap-3 rounded-2xl bg-muted px-3 py-2.5">
        <ContextRing percent={view.percent} state={view.state} size={40} />
        <div className="min-w-0">
          <p className="text-lg leading-tight font-semibold tabular-nums">{Math.round(view.percent)} %</p>
          <p className="text-xs text-muted-foreground">
            {view.live ? "Génération en cours — mesure du serveur IA" : usage.lastRequest?.promptTokens ? "Dernière mesure réelle · prochain prompt estimé" : "Prochain prompt estimé avant le premier appel"}
          </p>
        </div>
      </div>

      <dl className="flex flex-col">
        <Row label="Contexte utilisé" value={`≈ ${fmt(view.used)} tokens`} />
        {usage.lastRequest?.promptTokens && <Row label="Dernier prompt mesuré" value={`${fmt(usage.lastRequest.promptTokens)} tokens`} hint="mesure renvoyée par le serveur IA" />}
        <Row label="Contexte restant" value={remaining >= 0 ? `≈ ${fmt(remaining)} tokens` : <span className="text-destructive">dépassé de {fmt(-remaining)}</span>} />
        <Row
          label="Capacité effective"
          value={`${fmt(usage.capacity)} tokens`}
          hint={`fenêtre ${fmt(usage.window)} − ${fmt(usage.reserve)} réservés à la réponse`}
        />
        <Row label="Modèle actif" value={<span className="break-all">{usage.model}</span>} />
        <Row
          label="Fenêtre"
          value={<span className="text-xs font-normal">{WINDOW_SOURCE_LABELS[usage.windowSource]}</span>}
          hint={usage.providerMax ? `maximum annoncé par le modèle : ${fmt(usage.providerMax)}` : undefined}
        />
      </dl>

      {parts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Répartition (estimée)</p>
          <ul className="flex flex-col gap-1.5">
            {parts.map((k) => (
              <li key={k} className="flex flex-col gap-0.5">
                <div className="flex justify-between gap-2 text-xs">
                  <span>{PART_LABELS[k]}</span>
                  <span className="tabular-nums text-muted-foreground">≈ {fmt(usage.parts[k])}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-context-track">
                  <div className="h-full rounded-full bg-context transition-[width] duration-500" style={{ width: `${(usage.parts[k] / total) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Réflexion (Thinking) : jamais retransmise aux messages suivants. Documents Web : ajoutés seulement à la question qui les déclenche.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1 rounded-2xl bg-muted px-3 py-2.5 text-xs text-muted-foreground">
        <p>
          {usage.messages.total} message(s) dans l&apos;historique
          {usage.messages.summarized > 0 && ` · ${usage.messages.summarized} résumé(s) dans le contexte compacté`}
          {` · ${usage.messages.sent} transmis intégralement`}
          {usage.messages.dropped > 0 && (
            <span className="text-destructive"> · {usage.messages.dropped} exclu(s) faute de place</span>
          )}
        </p>
        {usage.lastRequest && (
          <p>
            Dernière requête :{" "}
            {usage.lastRequest.promptTokens ? `${fmt(usage.lastRequest.promptTokens)} tokens mesurés par le serveur IA` : `≈ ${fmt(usage.lastRequest.estimated)} tokens (non mesurés par le serveur)`}
            {usage.lastRequest.rag > 0 && `, dont ≈ ${fmt(usage.lastRequest.rag)} de documents Web`}
            {usage.lastRequest.completionTokens ? ` · réponse : ${fmt(usage.lastRequest.completionTokens)} tokens` : ""}.
          </p>
        )}
        <p>
          Estimation par {usage.estimator}
          {cal ? `, recalibrée ×${cal.factor.toFixed(2).replace(".", ",")} d'après la dernière mesure (${fmt(cal.measured)} mesurés pour ≈ ${fmt(cal.estimated)} estimés).` : " (aucune mesure du serveur pour recalibrer)."}
        </p>
        <p>
          Mémoire persistante :{" "}
          {usage.memory.enabled ? `${usage.memory.injected.length} souvenir(s) pertinent(s) injecté(s)` : "désactivée"} ·{" "}
          <Link href="/settings/memory" className="font-medium text-foreground underline underline-offset-4">
            Gérer
          </Link>
        </p>
      </div>

      {usage.compaction.status === "FAILED" && usage.compaction.error && (
        <p className="rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">Dernière réduction : {usage.compaction.error}</p>
      )}
      {props.lastResult && "before" in props.lastResult && (
        <p className="rounded-2xl bg-success/12 px-3 py-2 text-xs text-success">
          Contexte réduit : ≈ {fmt(props.lastResult.before)} → {fmt(props.lastResult.after)} tokens (estimation).
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button variant="secondary" className="justify-between" onClick={props.onShowSummary}>
          <span className="flex items-center gap-2">
            <FileText /> Voir le résumé du contexte
          </span>
          <ChevronRight />
        </Button>
        <CompactButton {...props} />
      </div>
    </div>
  );
}

function CompactButton(props: Props) {
  const { usage } = props;
  if (!usage) return null;
  const nothing = usage.compactable === 0;
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={usage.state === "high" || usage.state === "critical" ? "default" : "outline"}
        disabled={!props.canCompact || props.compacting || props.busy || nothing}
        onClick={props.onCompact}
      >
        {props.compacting ? <Loader2 className="animate-spin" /> : <Minimize2 />}
        {props.compacting ? "Réduction en cours…" : "Réduire le contexte"}
      </Button>
      <p className="text-xs text-muted-foreground">
        {!props.canCompact
          ? "Disponible une fois la conversation commencée."
          : props.busy
            ? "Disponible à la fin de la réponse en cours."
            : nothing
              ? "Rien à compacter : les échanges récents sont toujours transmis intégralement."
              : `Résume ${usage.compactable} message(s) ancien(s) pour les prochains prompts. Les messages restent dans l'historique.`}
      </p>
    </div>
  );
}

function SummaryPage(props: Props & { onBack: () => void }) {
  const summary = props.usage?.summary ?? null;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={props.onBack} aria-label="Retour aux détails du contexte">
          <ArrowLeft />
        </Button>
        <p className="font-semibold">Résumé du contexte</p>
      </div>
      {!summary ? (
        <>
          <p className="rounded-2xl bg-muted px-3 py-3 text-muted-foreground">
            Aucun résumé n&apos;a encore été généré pour cette conversation. Tant qu&apos;aucune réduction n&apos;a eu lieu, les messages sont transmis au
            modèle tels quels, dans la limite de sa fenêtre de contexte.
          </p>
          <CompactButton {...props} />
        </>
      ) : (
        <SummaryContent summary={summary} />
      )}
    </div>
  );
}

function SummaryContent({ summary }: { summary: SummaryDTO }) {
  const s = summary.sections;
  const block = (title: string, items: string[]) =>
    items.length > 0 && (
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {items.map((i, n) => (
            <li key={n} className="break-words">
              {i}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <>
      <p className="rounded-2xl bg-context/10 px-3 py-2 text-xs">
        Ce résumé remplace {summary.coveredCount} message(s) ancien(s) dans le contexte envoyé au modèle, pour maintenir la continuité. L&apos;historique
        complet reste affiché dans la conversation.
      </p>
      <p className="text-xs text-muted-foreground">
        Version {summary.version} · {summary.trigger === "auto" ? "compaction automatique" : "réduction manuelle"} · {formatDate(summary.createdAt)} ·{" "}
        {summary.model} · ≈ {fmt(summary.tokens)} tokens
        {summary.tokensBefore && summary.tokensAfter ? ` · contexte ≈ ${fmt(summary.tokensBefore)} → ${fmt(summary.tokensAfter)}` : ""}
      </p>
      {s.objective && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted-foreground">Objectif</h3>
          <p className="break-words">{s.objective}</p>
        </section>
      )}
      {block("Demandes de l'utilisateur (citées)", s.requests ?? [])}
      {block("Contraintes et préférences", s.constraints)}
      {block("Décisions prises", s.decisions)}
      {block("Informations établies", s.facts)}
      {block("Avancement", s.state)}
      {block("Points ouverts et prochaines étapes", s.nextSteps)}
      {s.references.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground">Références conservées</h3>
          <ul className="flex flex-col gap-1.5">
            {s.references.map((r, i) => (
              <li key={i} className="min-w-0 text-xs break-words">
                {r.type === "source" || r.type === "url" ? (
                  <a href={r.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">
                    {r.type === "source" ? `Source : ${r.label}` : r.url}
                  </a>
                ) : r.type === "file" ? (
                  <span>
                    Fichier : <code className="rounded bg-muted px-1 font-mono">{r.label}</code>
                  </span>
                ) : (
                  <div className="flex flex-col gap-1">
                    <span>{r.label}</span>
                    {r.code && <pre className="max-h-40 overflow-auto rounded-xl bg-code p-2 font-mono text-[0.7rem]">{r.code}</pre>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Bandeau affiché au-dessus de la saisie quand le contexte approche de sa limite. */
export function ContextBanner(props: { view: ContextView | null; usage: ContextUsageDTO | null; compacting: boolean; busy: boolean; onCompact: () => void; onDismiss: () => void }) {
  const { view, usage } = props;
  if (!view || !usage || view.live || (view.state !== "high" && view.state !== "critical") || usage.compactable === 0) return null;
  const critical = view.state === "critical";
  return (
    <div
      role="status"
      className={cn("mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-2.5 text-sm", critical ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning-foreground")}
    >
      <p className="min-w-0 flex-1">
        {critical
          ? `Contexte plein (${Math.round(view.percent)} %) : les plus anciens messages ne peuvent plus être transmis au modèle.`
          : `Contexte utilisé à ${Math.round(view.percent)} % : il reste peu de place pour la suite de la conversation.`}{" "}
        Réduisez-le pour conserver l&apos;essentiel sous forme de résumé.
      </p>
      <div className="flex gap-1">
        <Button size="sm" variant={critical ? "default" : "secondary"} onClick={props.onCompact} disabled={props.compacting || props.busy}>
          {props.compacting ? <Loader2 className="animate-spin" /> : <Minimize2 />} Réduire le contexte
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onDismiss}>
          Plus tard
        </Button>
      </div>
    </div>
  );
}
