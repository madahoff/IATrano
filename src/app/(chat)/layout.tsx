import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { listConversations } from "@/lib/chat/service";
import { AppProvider } from "@/components/layout/app-context";
import { ChatShell } from "@/components/layout/chat-shell";
import { ThemeSync } from "@/components/common/theme-sync";
import { db } from "@/lib/db";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const [conversations, settings] = await Promise.all([
    listConversations(user.id),
    db.userSettings.findUnique({ where: { userId: user.id }, select: { theme: true } }),
  ]);
  return (
    <AppProvider
      user={{ id: user.id, email: user.email, name: user.name, role: user.role, isAdmin: hasPermission(user.role, "admin:access") }}
      initialConversations={conversations}
    >
      <ThemeSync preference={settings?.theme ?? null} />
      <ChatShell>{children}</ChatShell>
    </AppProvider>
  );
}
