import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth/guard";
import { getConversationWithMessages } from "@/lib/chat/service";
import { ChatView } from "@/components/chat/chat-view";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser();
  // Filtré par propriétaire : la conversation d'un autre utilisateur renvoie une 404.
  const conversation = await getConversationWithMessages(user.id, id);
  if (!conversation) notFound();
  return <ChatView key={conversation.id} conversation={conversation} />;
}
