import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import { getContextAdminView } from "@/lib/context/admin";
import { MAX_WINDOW, MIN_WINDOW } from "@/lib/context/window";

// Fenêtre de contexte manuelle par modèle (prioritaire sur le défaut et sur la valeur annoncée).

const putSchema = z.object({
  model: z.string().min(1).max(200),
  contextWindow: z.number().int().min(MIN_WINDOW, `Au moins ${MIN_WINDOW} tokens.`).max(MAX_WINDOW),
  responseReserve: z.number().int().min(128).max(32_768).nullable().optional(),
});

export const PUT = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const { model, contextWindow, responseReserve } = await parseJson(req, putSchema);
  if (responseReserve && responseReserve > contextWindow / 2) throw badRequest("La réserve ne peut pas dépasser la moitié de la fenêtre.");
  await db.modelContextConfig.upsert({
    where: { model },
    update: { contextWindow, responseReserve: responseReserve ?? null, updatedById: user.id },
    create: { model, contextWindow, responseReserve: responseReserve ?? null, updatedById: user.id },
  });
  await logEvent("INFO", "admin:context", `Fenêtre manuelle pour ${model}`, { contextWindow, responseReserve }, user.id);
  return json(await getContextAdminView());
});

const deleteSchema = z.object({ model: z.string().min(1).max(200) });

export const DELETE = route(async (req) => {
  await requireApiUser("settings:manage");
  const { model } = await parseJson(req, deleteSchema);
  await db.modelContextConfig.deleteMany({ where: { model } });
  return json(await getContextAdminView());
});
