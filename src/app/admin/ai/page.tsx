import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { getAppSettings, publicAppSettings } from "@/lib/settings/service";
import { inDocker } from "@/lib/llm/url";
import { AiSettingsView } from "@/components/admin/ai-settings-view";

export const metadata: Metadata = { title: "Serveur IA" };

export default async function AdminAiPage() {
  await requirePagePermission("settings:manage");
  const settings = publicAppSettings(await getAppSettings());
  return <AiSettingsView initial={settings} inDocker={inDocker()} />;
}
