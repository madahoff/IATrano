import "server-only";
import { db } from "@/lib/db";
import type { LlmProvider } from "@/lib/llm/types";
import { evaluateCandidate } from "./evaluate";
import {
  assessMemoryPotential,
  buildMemoryExtractionPrompt,
  explicitRememberFallback,
  extractByRules,
  MEMORY_ACTIONS_JSON_SCHEMA,
  parseMemoryActions,
  userAuthoredText,
  type MemoryAction,
} from "./extract";
import { coverage, similarity } from "./select";
import { sensitiveReason } from "./sensitive";
import { getMemorySettings } from "./service";
import { applyOperations, type PlannedOperation } from "./store";
import { emptyMemoryUpdate, type MemoryCandidate, type MemoryUpdate } from "./types";

// Pipeline d'analyse d'un message de l'utilisateur : extraction → évaluation → stockage / mise à jour.
// Appelé par la file d'attente (src/lib/memory/jobs.ts), jamais directement pendant la génération d'une réponse.

/** Souvenirs existants présentés au modèle (les plus proches du message) : prompt court, références stables. */
const PROMPT_MEMORIES = 30;

export type AnalyzeOptions = {
  userId: string;
  conversationId: string | null;
  projectId: string | null;
  /** Message tel qu'enregistré (les citations et documents collés sont retirés ici). */
  text: string;
  sourceCreatedAt: Date;
  /** null : règles déterministes seulement (modèle indisponible). */
  provider: LlmProvider | null;
  model: string;
  think: boolean | undefined;
  signal?: AbortSignal;
  /** Dernière tentative : si le modèle échoue encore, les règles et les demandes explicites sont appliquées sans lui. */
  finalAttempt?: boolean;
};

export class MemoryExtractionError extends Error {}

export async function analyzeMessage(opts: AnalyzeOptions): Promise<MemoryUpdate> {
  const settings = await getMemorySettings(opts.userId);
  if (!settings.enabled) return emptyMemoryUpdate();
  const userText = userAuthoredText(opts.text);
  const signal = assessMemoryPotential(userText);
  const explicit = signal.explicitRemember || signal.explicitForget;
  if (!signal.potential || (!settings.autoSave && !explicit)) return emptyMemoryUpdate();
  // Un message contenant un secret n'est jamais transmis à l'extraction.
  const secret = sensitiveReason(userText);
  if (secret) return { ...emptyMemoryUpdate(), rejected: [secret] };

  const project = opts.projectId ? await db.project.findFirst({ where: { id: opts.projectId, userId: opts.userId }, select: { id: true, name: true, memoryEnabled: true } }) : null;
  const projectId = project?.memoryEnabled ? project.id : null;

  const rules = extractByRules(userText);
  const ops: PlannedOperation[] = rules.forget.map((query) => ({ op: "forget" as const, query }));
  const proposals: Array<{ candidate: MemoryCandidate; replaces: string | null }> = rules.candidates.map((candidate) => ({ candidate, replaces: null }));

  let degraded: string | undefined;
  if (!rules.covered) {
    let actions: MemoryAction[] | null = null;
    if (opts.provider) {
      try {
        actions = await extractWithModel(opts, userText, projectId, project?.name ?? null, explicit, signal.explicitForget);
      } catch (err) {
        degraded = err instanceof Error ? err.message : "Extraction impossible.";
        if (!opts.finalAttempt) throw new MemoryExtractionError(degraded);
      }
    } else {
      degraded = "Aucun modèle disponible pour l'analyse de la mémoire.";
      if (!opts.finalAttempt) throw new MemoryExtractionError(degraded);
    }
    if (actions) {
      for (const a of actions) {
        if (a.action === "delete") ops.push({ op: "delete", id: a.id });
        // Une proposition déjà couverte par une règle n'est pas dupliquée.
        else if (!proposals.some((p) => similarity(p.candidate.content, a.candidate.content) >= 0.75)) {
          proposals.push({ candidate: a.candidate, replaces: a.action === "update" ? a.id : null });
        }
      }
    } else if (signal.explicitRemember) {
      // Modèle indisponible après plusieurs tentatives : la demande explicite est conservée telle quelle.
      for (const candidate of explicitRememberFallback(userText)) {
        if (!proposals.some((p) => similarity(p.candidate.content, candidate.content) >= 0.75)) proposals.push({ candidate, replaces: null });
      }
    }
  }

  const rejected: string[] = [];
  for (const p of proposals) {
    const evaluation = evaluateCandidate(p.candidate, { explicit: signal.explicitRemember });
    if (evaluation.ok) ops.push({ op: "upsert", candidate: evaluation.candidate, replaces: p.replaces });
    else if (!evaluation.silent && !rejected.includes(evaluation.reason)) rejected.push(evaluation.reason);
  }
  const result = await applyOperations(
    { userId: opts.userId, conversationId: opts.conversationId, projectId, sourceCreatedAt: opts.sourceCreatedAt, explicit: signal.explicitRemember },
    ops,
  );
  result.rejected.push(...rejected.filter((r) => !result.rejected.includes(r)));
  if (degraded) result.degraded = degraded;
  return result;
}

async function extractWithModel(opts: AnalyzeOptions, userText: string, projectId: string | null, projectName: string | null, explicit: boolean, allowDelete: boolean) {
  const pool = await db.memory.findMany({
    where: { userId: opts.userId, status: "ACTIVE", OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const existing = pool
    .map((m) => ({ m, score: (m.kind === "PREFERENCE" ? 0.5 : 0) + coverage(m.content, userText) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PROMPT_MEMORIES)
    .map((x) => x.m);
  const refs = new Map(existing.map((m, i) => [`M${i + 1}`, m.id]));
  const raw = await opts.provider!.completeJson(
    {
      model: opts.model,
      messages: buildMemoryExtractionPrompt(
        userText,
        existing.map((m, i) => ({ ref: `M${i + 1}`, scope: m.projectId ? "project" : "personal", kind: m.kind, project: m.project, topic: m.topic, content: m.content })),
        { projectName: projectId ? projectName : null, explicit },
      ),
      think: opts.think,
      temperature: 0,
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    },
    MEMORY_ACTIONS_JSON_SCHEMA as unknown as Record<string, unknown>,
  );
  // Une sortie illisible est un échec (nouvelle tentative), pas un « rien à retenir ».
  try {
    JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("Réponse du modèle illisible pour la mémoire.");
  }
  return parseMemoryActions(raw, refs, userText, { allowDelete });
}
