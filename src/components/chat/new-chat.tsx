"use client";

import { useApp } from "@/components/layout/app-context";
import { ChatView } from "./chat-view";

export function NewChat() {
  const { newChatKey } = useApp();
  return <ChatView key={`new-${newChatKey}`} conversation={null} />;
}
