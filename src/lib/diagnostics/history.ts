import "server-only";
import type { ConnectionTarget, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { DiagnosticReport } from "./report";

export const HISTORY_SIZE = 20;

/** Enregistre un rapport et ne conserve que les 20 derniers pour cette cible. */
export async function recordTestRun(report: DiagnosticReport, userId: string | null) {
  const target = report.target as ConnectionTarget;
  const run = await db.connectionTestRun.create({
    data: { target, verdict: report.verdict, latencyMs: report.totalMs, report: report as unknown as Prisma.InputJsonValue, userId },
  });
  const old = await db.connectionTestRun.findMany({ where: { target }, orderBy: { createdAt: "desc" }, skip: HISTORY_SIZE, select: { id: true } });
  if (old.length) await db.connectionTestRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return run;
}

export async function listTestRuns(target: ConnectionTarget) {
  const runs = await db.connectionTestRun.findMany({ where: { target }, orderBy: { createdAt: "desc" }, take: HISTORY_SIZE });
  return runs.map((r) => ({ id: r.id, verdict: r.verdict, latencyMs: r.latencyMs, createdAt: r.createdAt.toISOString(), report: r.report as unknown as DiagnosticReport }));
}
export type TestRunSummary = Awaited<ReturnType<typeof listTestRuns>>[number];
