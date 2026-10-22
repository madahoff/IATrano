import "server-only";
import type { AppSettings, Message, Prisma, RoutingDecision, RoutingSettings } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import type { ModelInfo } from "@/lib/llm/types";
import { safeJevDecide } from "@/lib/jev/service";
import { isSearchConfigured, searchConfigFrom } from "@/lib/search/providers";
import { buildJevState, clip } from "./jev-state";
import { parseModesConfig, ROUTING_FACTORY_DEFAULTS, ROUTING_MODES, type AuthMode, type ModesConfig, type RoutingMode, type RoutingSettingsInput } from "./config";
import {
  applyConfirmation,
  autoAcceptAfter,
  decideRouting,
  finalModes,
  snapshotOf,
  type Availability,
  type ConfirmationChoice,
  type Outcomes,
  type Overrides,
  type RoutingSnapshot,
} from "./decide";

// ---------------------------------------------------------------- Réglages

export async function getRoutingSettings(): Promise<RoutingSettings> {
  const existing = await db.routingSettings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  const d = ROUTING_FACTORY_DEFAULTS;
  return db.routingSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, modes: d.modes as unknown as Prisma.InputJsonValue, defaultAuthMode: d.defaultAuthMode, highThreshold: d.highThreshold, fallbackModes: d.fallbackModes, includeContext: d.includeContext },
  });
}

const asModes = (list: string[]): RoutingMode[] => list.filter((m): m is RoutingMode => (ROUTING_MODES as readonly string[]).includes(m));

export function routingConfigFrom(s: RoutingSettings): RoutingSettingsInput {
  return { modes: parseModesConfig(s.modes), defaultAuthMode: s.defaultAuthMode, highThreshold: s.highThreshold, fallbackModes: asModes(s.fallbackModes), includeContext: s.includeContext };
}

export async function saveRoutingSettings(input: RoutingSettingsInput, userId: string): Promise<RoutingSettings> {
  await getRoutingSettings();
  return db.routingSettings.update({
    where: { id: 1 },
    data: {
      modes: input.modes as unknown as Prisma.InputJsonValue,
      defaultAuthMode: input.defaultAuthMode,
      highThreshold: input.highThreshold,
      fallbackModes: input.fallbackModes,
      includeContext: input.includeContext,
      updatedById: userId,
    },
  });
}

/** Mode d'autorisation effectif : choix de l'utilisateur, sinon valeur de l'administration. */
export async function effectiveAuthMode(userId: string, settings?: RoutingSettings): Promise<AuthMode> {
  const [s, user] = await Promise.all([settings ?? getRoutingSettings(), db.userSettings.findUnique({ where: { userId }, select: { routingAuthMode: true } })]);
  return user?.routingAuthMode ?? s.defaultAuthMode;
}

/** Disponibilité réelle de chaque mode (indépendante de JEV). */
export function availabilityFor(app: AppSettings, model: ModelInfo | null): Availability {
  return {
    thinking: model && model.capabilities.thinking === "no" ? { available: false, reason: `Le modèle « ${model.name} » ne prend pas en charge la réflexion approfondie.` } : { available: true },
    research: !app.webSearchEnabled
      ? { available: false, reason: "La recherche Web est désactivée par l'administration." }
      : !isSearchConfigured(searchConfigFrom(app))
        ? { available: false, reason: "Aucun moteur de recherche n'est configuré." }
        : { available: true },
    interactive: { available: true },
  };
}

// ---------------------------------------------------------------- Proposition

export type RoutingProposal = {
  decisionId: string;
  authMode: AuthMode;
  outcomes: Outcomes;
  needsConfirmation: boolean;
  jev: { consulted: boolean; ok: boolean; error?: string; latencyMs?: number; model?: string };
};

const PENDING_TTL_MS = 30 * 60_000;

export async function proposeRouting(opts: {
  userId: string;
  conversationId: string | null;
  content: string;
  /** Message utilisateur réanalysé (édition, régénération) : seul ce qui le précède sert de contexte. */
  anchorMessageId?: string | null;
  authMode: AuthMode;
  overrides: Overrides;
  app: AppSettings;
  model: ModelInfo | null;
}): Promise<RoutingProposal> {
  const settings = await getRoutingSettings();
  const config = routingConfigFrom(settings);
  let autoAccept: RoutingMode[] = [];
  let previous: Array<Pick<Message, "role" | "content">> = [];
  if (opts.conversationId) {
    const conv = await db.conversation.findFirst({ where: { id: opts.conversationId, userId: opts.userId }, select: { id: true, routingAutoAccept: true } });
    if (!conv) throw notFound("Conversation introuvable.");
    autoAccept = asModes(conv.routingAutoAccept);
    const anchor = opts.anchorMessageId ? await db.message.findFirst({ where: { id: opts.anchorMessageId, conversationId: conv.id }, select: { createdAt: true } }) : null;
    previous = (
      await db.message.findMany({
        where: { conversationId: conv.id, ...(anchor ? { createdAt: { lt: anchor.createdAt } } : {}) },
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { role: true, content: true },
      })
    ).reverse();
  }

  let probabilities: Record<RoutingMode, number> | null = null;
  let jev: RoutingProposal["jev"] = { consulted: false, ok: true };
  if (opts.authMode !== "OFF") {
    const r = await safeJevDecide(
      buildJevState(opts.content, previous, config.includeContext),
      ROUTING_MODES.map((m) => ({ name: m, instructions: config.modes[m].question })),
    );
    if (r.ok) {
      probabilities = r.decision.answers as Record<RoutingMode, number>;
      jev = { consulted: true, ok: true, latencyMs: r.decision.timing.totalMs, model: r.decision.model };
    } else {
      jev = { consulted: true, ok: false, error: r.error };
      await logEvent("WARN", "routing:jev", `JEV injoignable, mode de repli appliqué : ${r.error}`, { code: r.code }, opts.userId);
    }
  }

  const { outcomes, needsConfirmation } = decideRouting({
    authMode: opts.authMode,
    modes: config.modes,
    highThreshold: config.highThreshold,
    probabilities,
    jevFailed: jev.consulted && !jev.ok,
    fallbackModes: config.fallbackModes,
    overrides: opts.overrides,
    autoAccept,
    availability: availabilityFor(opts.app, opts.model),
  });

  const decision = await db.routingDecision.create({
    data: {
      userId: opts.userId,
      conversationId: opts.conversationId,
      excerpt: clip(opts.content, 300),
      authMode: opts.authMode,
      probabilities: probabilities ?? undefined,
      config: { modes: config.modes, highThreshold: config.highThreshold, fallbackModes: config.fallbackModes, overrides: opts.overrides, autoAccept } as unknown as Prisma.InputJsonValue,
      outcomes: outcomes as unknown as Prisma.InputJsonValue,
      // Sans confirmation, la décision est déjà définitive.
      finalModes: needsConfirmation ? [] : finalModes(outcomes),
      jevModel: jev.model,
      jevLatencyMs: jev.latencyMs,
      jevError: jev.error,
    },
  });
  return { decisionId: decision.id, authMode: opts.authMode, outcomes, needsConfirmation, jev };
}

// ---------------------------------------------------------------- Application

export type AppliedRouting = {
  decision: RoutingDecision;
  outcomes: Outcomes;
  modes: RoutingMode[];
  snapshot: RoutingSnapshot;
  choice: ConfirmationChoice | null;
  accepted: RoutingMode[];
};

/**
 * Valide la décision proposée (propriétaire, non expirée, non utilisée) et applique la réponse à la carte.
 * Les états viennent toujours de la base : le navigateur ne transmet que le choix et les cases cochées.
 */
export async function resolveRouting(userId: string, input: { decisionId: string; choice?: ConfirmationChoice; accepted?: RoutingMode[] }): Promise<AppliedRouting> {
  const decision = await db.routingDecision.findFirst({ where: { id: input.decisionId, userId } });
  if (!decision) throw notFound("Proposition de routage introuvable.");
  if (decision.status !== "PENDING") throw new AppError(409, "routing_used", "Cette proposition a déjà été utilisée : renvoyez le message.");
  if (Date.now() - decision.createdAt.getTime() > PENDING_TTL_MS) throw new AppError(409, "routing_expired", "Cette proposition a expiré : renvoyez le message.");
  let outcomes = decision.outcomes as unknown as Outcomes;
  const needsConfirmation = ROUTING_MODES.some((m) => outcomes[m]?.state === "ask");
  const accepted = asModes(input.accepted ?? []);
  if (needsConfirmation) {
    if (!input.choice) throw badRequest("Confirmez ou refusez les modes proposés par JEV.", "routing_confirmation_required");
    outcomes = applyConfirmation(outcomes, input.choice, accepted);
  }
  return {
    decision,
    outcomes,
    modes: finalModes(outcomes),
    snapshot: snapshotOf(decision.authMode, outcomes, Boolean(decision.jevError)),
    choice: needsConfirmation ? input.choice! : null,
    accepted,
  };
}

/** Marque la décision comme appliquée à une réponse et mémorise « Toujours accepter » si demandé. */
export async function attachRouting(applied: AppliedRouting, conversationId: string, assistantMessageId: string): Promise<boolean> {
  const { count } = await db.routingDecision.updateMany({
    where: { id: applied.decision.id, status: "PENDING" },
    data: {
      status: "APPLIED",
      appliedAt: new Date(),
      conversationId,
      messageId: assistantMessageId,
      outcomes: applied.outcomes as unknown as Prisma.InputJsonValue,
      finalModes: applied.modes,
      userChoice: applied.choice,
    },
  });
  if (count === 0) return false;
  await db.message.update({ where: { id: assistantMessageId }, data: { routing: applied.snapshot as unknown as Prisma.InputJsonValue } });
  if (applied.choice === "always") {
    const conv = await db.conversation.findUnique({ where: { id: conversationId }, select: { routingAutoAccept: true } });
    // Les modes à mémoriser sont ceux qui étaient proposés (état « ask » avant confirmation) et cochés.
    const proposed = applied.decision.outcomes as unknown as Outcomes;
    const next = autoAcceptAfter(proposed, "always", applied.accepted, asModes(conv?.routingAutoAccept ?? []));
    await db.conversation.update({ where: { id: conversationId }, data: { routingAutoAccept: next } });
  }
  return true;
}

export type { ModesConfig };
