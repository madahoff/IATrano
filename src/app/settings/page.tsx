import type { Metadata } from "next";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { getAppSettings } from "@/lib/settings/service";
import { PageShell } from "@/components/layout/page-shell";
import { SettingsView } from "@/components/settings/settings-view";
import { PROVIDER_LABELS } from "@/lib/llm/registry";

export const metadata: Metadata = { title: "Paramètres" };

export default async function SettingsPage() {
  const user = await requirePageUser();
  const [settings, app] = await Promise.all([db.userSettings.findUnique({ where: { userId: user.id } }), getAppSettings()]);
  return (
    <PageShell title="Paramètres" subtitle={user.email}>
      <SettingsView
        user={{ id: user.id, name: user.name, email: user.email, role: user.role }}
        isAdmin={hasPermission(user.role, "settings:manage")}
        preferences={{
          defaultModel: settings?.defaultModel ?? null,
          thinkingDefault: settings?.thinkingDefault ?? null,
          clarificationsEnabled: settings?.clarificationsEnabled ?? null,
          webSearchDefault: settings?.webSearchDefault ?? null,
        }}
        app={{
          providerLabel: PROVIDER_LABELS[app.providerType],
          defaultModel: app.defaultModel,
          thinkingDefault: app.thinkingDefault,
          clarificationsEnabled: app.clarificationsEnabled,
          webSearchAutoDefault: app.webSearchAutoDefault,
          webSearchEnabled: app.webSearchEnabled,
        }}
      />
    </PageShell>
  );
}
