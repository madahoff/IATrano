import { Sparkle } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex size-8 items-center justify-center rounded-2xl bg-primary text-primary-foreground", className)}>
      <Sparkle className="size-[55%]" strokeWidth={2.2} />
    </span>
  );
}
