"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Contexte non sécurisé (http sur le réseau local) : repli sur execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = "Copier", className, showLabel }: { text: string; label?: string; className?: string; showLabel?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const btn = (
    <Button variant="ghost" size={showLabel ? "xs" : "icon-sm"} onClick={onClick} aria-label={copied ? "Copié" : label} className={cn("text-muted-foreground", className)}>
      {copied ? <Check className="text-success" /> : <Copy />}
      {showLabel && (copied ? "Copié" : label)}
    </Button>
  );
  if (showLabel) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{copied ? "Copié" : label}</TooltipContent>
    </Tooltip>
  );
}
