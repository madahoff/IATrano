import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import { getContextAdminView } from "@/lib/context/admin";
import { MAX_WINDOW, MIN_WINDOW } from "@/lib/context/window";
import { getAppSettings } from "@/lib/settings/service";

// Réglages du contexte et de la mémoire (administration). Aucune mémoire d'utilisateur n'est exposée ici.

export const GET = route(async () => {
  await requireApiUser("settings:manage");
  return json(await getContextAdminView());
});

const schema = z
  .object({
    contextDefaultWindow: z.number().int().min(MIN_WINDOW).max(MAX_WINDOW),
    contextResponseReserve: z.number().int().min(128).max(32_768),
    contextWarnPct: z.number().int().min(10).max(99),
    contextHighPct: z.number().int().min(10).max(99),
    contextAutoCompactPct: z.number().int().min(0).max(100),
    memoryFeatureEnabled: z.boolean(),
    // "" ou null : modèle de la conversation
    memoryModel: z.string().trim().max(200).nullable(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, "Aucune modification.");

export const PATCH = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const data = await parseJson(req, schema);
  const current = await getAppSettings();
  const warn = data.contextWarnPct ?? current.contextWarnPct;
  const high = data.contextHighPct ?? current.contextHighPct;
  if (warn >= high) throw badRequest("Le seuil d'avertissement doit être inférieur au seuil élevé.");
  const window = data.contextDefaultWindow ?? current.contextDefaultWindow;
  const reserve = data.contextResponseReserve ?? current.contextResponseReserve;
  if (reserve > window / 2) throw badRequest("La réserve de réponse ne peut pas dépasser la moitié de la fenêtre.");
  await db.appSettings.update({ where: { id: 1 }, data: { ...data, ...(data.memoryModel !== undefined ? { memoryModel: data.memoryModel || null } : {}), updatedById: user.id } });
  await logEvent("INFO", "admin:context", "Réglages du contexte modifiés", data, user.id);
  return json(await getContextAdminView());
});
