import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { listConversations } from "@/lib/chat/service";
import { AppProvider } from "@/components/layout/app-context";
import { ChatShell } from "@/components/layout/chat-shell";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const conversations = await listConversations(user.id);
  return (
    <AppProvider
      user={{ id: user.id, email: user.email, name: user.name, role: user.role, isAdmin: hasPermission(user.role, "admin:access") }}
      initialConversations={conversations}
    >
      <ChatShell>{children}</ChatShell>
    </AppProvider>
  );
}
