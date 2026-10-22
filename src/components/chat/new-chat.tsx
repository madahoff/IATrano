"use client";

import { useApp } from "@/components/layout/app-context";
import { useSearchParams } from "next/navigation";
import { ChatView } from "./chat-view";

export function NewChat() {
  const { newChatKey } = useApp();
  const params = useSearchParams();
  const projectId = params.get("projectId");
  return <ChatView key={`new-${newChatKey}-${projectId ?? ""}`} conversation={projectId ? { projectId } : null} />;
}
