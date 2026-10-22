import Image from "next/image";
import { cn } from "@/lib/utils";
import tranoBust from "@/components/mascot/assets/trano-bust.png";

/** Logo IATrano : rendu fixe de la mascotte 3D « Trano » (aucun moteur 3D chargé). */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block size-8 shrink-0", className)}>
      <Image src={tranoBust} alt="" fill unoptimized draggable={false} className="object-contain select-none" />
    </span>
  );
}
