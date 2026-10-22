// Rapport de test de connexion étape par étape (JEV et serveur LLM), partagé entre serveur et navigateur.

export type StepStatus = "ok" | "fail" | "skip";

export type DiagnosticStep = {
  id: string;
  label: string;
  status: StepStatus;
  durationMs: number | null;
  /** Ce qui a été observé (version, modèles, probabilité…). */
  detail?: string;
  /** Message d'échec (cause probable). */
  error?: string;
  /** Piste de correction. */
  hint?: string;
  warnings?: string[];
  /** Un échec (ou un saut) de cette étape rend la connexion inutilisable. */
  essential: boolean;
  /** Étape sans objet pour cette configuration : n'influe pas sur le verdict. */
  notApplicable?: boolean;
};

export type Verdict = "OK" | "PARTIAL" | "FAILED";

export type DiagnosticReport = {
  target: "JEV" | "LLM" | "SEARCH";
  title: string;
  endpoint: string;
  /** Description de la clé, toujours masquée. */
  keyInfo?: string;
  startedAt: string;
  totalMs: number;
  verdict: Verdict;
  steps: DiagnosticStep[];
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  OK: "Connexion opérationnelle",
  PARTIAL: "Connexion partielle",
  FAILED: "Échec",
};

/** Statut d'une étape dans le rapport texte (mots plutôt que pictogrammes : lisible partout, y compris en terminal). */
export const STEP_TAGS: Record<StepStatus, string> = { ok: "[OK]", fail: "[ÉCHEC]", skip: "[IGNORÉE]" };

export function computeVerdict(steps: DiagnosticStep[]): Verdict {
  if (steps.some((s) => s.essential && s.status !== "ok")) return "FAILED";
  if (steps.some((s) => s.status !== "ok" && !s.notApplicable)) return "PARTIAL";
  return "OK";
}

/** Étape non exécutée parce qu'une étape précédente a échoué. */
export function skipped(id: string, label: string, essential: boolean, reason = "Non exécutée : une étape précédente a échoué."): DiagnosticStep {
  return { id, label, status: "skip", durationMs: null, detail: reason, essential };
}

/** Remplace toute occurrence d'un secret par « •••• » (défense en profondeur avant stockage et affichage). */
export function redactReport(report: DiagnosticReport, secrets: Array<string | null | undefined>): DiagnosticReport {
  const list = secrets.filter((s): s is string => Boolean(s && s.length >= 4));
  if (!list.length) return report;
  const clean = (v?: string) => (v === undefined ? v : list.reduce((acc, s) => acc.split(s).join("••••"), v));
  return {
    ...report,
    keyInfo: clean(report.keyInfo),
    steps: report.steps.map((s) => ({ ...s, detail: clean(s.detail), error: clean(s.error), hint: clean(s.hint), warnings: s.warnings?.map((w) => clean(w)!) })),
  };
}

/** Rapport texte brut à copier-coller (la clé n'y figure jamais). */
export function formatReportText(report: DiagnosticReport): string {
  const lines = [
    `Rapport de test de connexion — ${report.title}`,
    `Date : ${new Date(report.startedAt).toLocaleString("fr-FR")}`,
    `Point d'accès : ${report.endpoint}`,
  ];
  if (report.keyInfo) lines.push(`Clé API : ${report.keyInfo}`);
  lines.push(`Verdict : ${VERDICT_LABELS[report.verdict]} (durée totale ${report.totalMs} ms)`, "");
  report.steps.forEach((s, i) => {
    const duration = s.durationMs === null ? "non exécutée" : `${s.durationMs} ms`;
    lines.push(`${STEP_TAGS[s.status]} ${i + 1}. ${s.label} — ${duration}`);
    if (s.detail) lines.push(`   ${s.detail}`);
    if (s.error) lines.push(`   Cause : ${s.error}`);
    if (s.hint) lines.push(`   Que faire : ${s.hint}`);
    for (const w of s.warnings ?? []) lines.push(`   Avertissement : ${w}`);
  });
  return lines.join("\n");
}
