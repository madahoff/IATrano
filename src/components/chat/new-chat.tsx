"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useApp } from "@/components/layout/app-context";
import { ChatView } from "./chat-view";

export function NewChat() {
  const { newChatKey } = useApp();
  const params = useSearchParams();
  const pathname = usePathname();
  const fromUrl = params.get("projectId");
  // Projet figé pour la durée de cette nouvelle conversation : après le premier message, l'URL passe à /c/<id>
  // (replaceState) et perd ?projectId. Sans ce gel, la vue se réinitialisait hors projet et les messages
  // suivants créaient une conversation détachée du projet.
  const [projectId, setProjectId] = useState(fromUrl);
  if (pathname === "/" && fromUrl !== projectId) setProjectId(fromUrl);
  return <ChatView key={`new-${newChatKey}-${projectId ?? ""}`} conversation={projectId ? { projectId } : null} />;
}
