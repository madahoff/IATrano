import { Brain, Globe, Sparkles, type LucideProps } from "lucide-react";
import type { RoutingMode } from "@/lib/routing/config";

const ICONS = { thinking: Brain, research: Globe, interactive: Sparkles } as const;

/** Icône d'un mode de routage (décorative : le libellé du mode l'accompagne toujours). */
export function ModeIcon({ mode, ...props }: { mode: RoutingMode } & LucideProps) {
  const Icon = ICONS[mode];
  return <Icon aria-hidden {...props} />;
}
