import "server-only";
import { db } from "./db";
import { getModels } from "./llm/discovery";
import { createProvider } from "./llm/registry";
import { inDocker } from "./llm/url";
import { getAppSettings, providerConfigFrom } from "./settings/service";

export async function getSystemStatus() {
  const started = Date.now();
  let database: { ok: boolean; latencyMs?: number; error?: string };
  try {
    await db.$queryRaw`SELECT 1`;
    database = { ok: true, latencyMs: Date.now() - started };
  } catch {
    database = { ok: false, error: "Base de données injoignable." };
  }
  const settings = await getAppSettings();
  const [ai, models, counts] = await Promise.all([
    createProvider(providerConfigFrom(settings)).testConnection(),
    getModels(),
    Promise.all([
      db.user.count(),
      db.conversation.count(),
      db.message.count(),
      db.errorLog.count({ where: { level: "ERROR", createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } } }),
    ]),
  ]);
  const defaultAvailable = settings.defaultModel ? models.models.some((m) => m.id === settings.defaultModel) : null;
  return {
    app: {
      version: process.env.npm_package_version ?? "0.1.0",
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      inDocker: inDocker(),
      env: process.env.NODE_ENV,
    },
    database,
    ai: { ...ai, defaultModel: settings.defaultModel, defaultModelAvailable: defaultAvailable, models: models.models.length },
    counts: { users: counts[0], conversations: counts[1], messages: counts[2], errors24h: counts[3] },
  };
}
