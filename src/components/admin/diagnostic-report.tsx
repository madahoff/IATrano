"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleSlash, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/common/copy-button";
import { Panel } from "@/components/layout/page-shell";
import { formatReportText, VERDICT_LABELS, type DiagnosticReport, type DiagnosticStep, type Verdict } from "@/lib/diagnostics/report";
import { cn } from "@/lib/utils";

const VERDICT_BADGE: Record<Verdict, "success" | "warning" | "destructive"> = { OK: "success", PARTIAL: "warning", FAILED: "destructive" };

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <Badge variant={VERDICT_BADGE[verdict]}>{VERDICT_LABELS[verdict]}</Badge>;
}

function StepIcon({ step }: { step: DiagnosticStep }) {
  if (step.status === "ok") return <CheckCircle2 className="size-5 text-success" aria-label="Réussie" />;
  if (step.status === "fail") return <XCircle className="size-5 text-destructive" aria-label="Échec" />;
  return <CircleSlash className="size-5 text-muted-foreground" aria-label="Non exécutée" />;
}

/** Rapport étape par étape avec verdict global et copie en texte brut (clé masquée). */
export function DiagnosticReportView({ report }: { report: DiagnosticReport }) {
  return (
    <Panel className={cn(report.verdict === "FAILED" && "bg-destructive/10", report.verdict === "PARTIAL" && "bg-warning/10")}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={report.verdict} />
        <span className="text-sm text-muted-foreground">
          {report.endpoint} · {report.totalMs} ms · {new Date(report.startedAt).toLocaleTimeString("fr-FR")}
        </span>
        <span className="flex-1" />
        <CopyButton text={formatReportText(report)} label="Copier le rapport" showLabel />
      </div>
      <ol className="flex flex-col gap-2">
        {report.steps.map((step, i) => (
          <li key={step.id} className="flex gap-3 rounded-2xl bg-background px-4 py-3 text-sm">
            <StepIcon step={step} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">
                  {i + 1}. {step.label}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">{step.durationMs === null ? "non exécutée" : `${step.durationMs} ms`}</span>
              </p>
              {step.detail && <p className="mt-0.5 break-words text-muted-foreground">{step.detail}</p>}
              {step.error && <p className="mt-1 break-words text-destructive">{step.error}</p>}
              {step.hint && (
                <p className="mt-0.5 break-words">
                  <span className="font-medium">Que faire : </span>
                  {step.hint}
                </p>
              )}
              {step.warnings?.map((w) => (
                <p key={w} className="mt-1 flex gap-1.5 break-words text-warning-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {w}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export type TestRun = { id: string; verdict: Verdict; latencyMs: number | null; createdAt: string; report: DiagnosticReport };

/** Historique des 20 derniers tests ; un clic déplie le rapport complet. */
export function TestHistory({ runs }: { runs: TestRun[] | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (runs === null) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (!runs.length) return <p className="text-sm text-muted-foreground">Aucun test pour l&apos;instant.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => setOpen(open === r.id ? null : r.id)}
            aria-expanded={open === r.id}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-muted"
          >
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open === r.id && "rotate-90")} />
            <span className="w-40 shrink-0 tabular-nums">{new Date(r.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" })}</span>
            <VerdictBadge verdict={r.verdict} />
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">{r.latencyMs ?? "—"} ms</span>
          </button>
          {open === r.id && (
            <div className="mt-1 mb-2">
              <DiagnosticReportView report={r.report} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
