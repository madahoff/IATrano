"use client";

import Image from "next/image";
import { memo, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { MascotState, SearchPhase } from "@/lib/mascot/state";
import { cn } from "@/lib/utils";
import type { MascotEngine } from "./engine";
import fullStill from "./assets/trano.png";
import bustStill from "./assets/trano-bust.png";

// Le moteur three.js n'est téléchargé qu'au premier affichage d'une mascotte animée,
// puis partagé par toutes les instances suivantes.
let engineModule: Promise<typeof import("./engine")> | null = null;
const loadEngine = () => (engineModule ??= import("./engine"));

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

function lowPowerDevice() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
}

type Props = {
  state: MascotState;
  phase?: SearchPhase;
  /** « full » : personnage entier (accueil) ; « compact » : cadrage sur la tête (fil de conversation). */
  variant?: "full" | "compact";
  /** Quantité de texte reçue en streaming : chaque augmentation anime la parole. */
  feed?: number;
  /** Compteur d'étapes réellement franchies : chaque incrément déclenche un hochement. */
  nudge?: number;
  /** Suivi du regard (voir EngineOptions.gaze) : « full » sur l'accueil, discret ailleurs. */
  gaze?: "full" | "eyes" | "none";
  /** Clic ou toucher sur la mascotte (petite réaction animée). */
  onPoke?: () => void;
  className?: string;
  priority?: boolean;
};

/**
 * Mascotte 3D « Trano ». Décorative (aria-hidden) : l'état est toujours donné en texte à côté.
 * Image fixe du même modèle pendant le chargement, sans WebGL ou si le contexte est perdu.
 */
export const Mascot = memo(function Mascot({ state, phase, variant = "full", feed = 0, nudge = 0, gaze = "eyes", onPoke, className, priority }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MascotEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const { resolvedTheme } = useTheme();
  const latest = useRef({ state, phase, dark: resolvedTheme === "dark", onPoke });
  useEffect(() => {
    latest.current = { state, phase, dark: resolvedTheme === "dark", onPoke };
  });
  const interactive = Boolean(onPoke);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    let cancelled = false;
    let cleanup = () => {};
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    (webglAvailable() ? loadEngine() : Promise.reject(new Error("WebGL indisponible")))
      .then(({ MascotEngine }) => {
        if (cancelled) return;
        const compact = variant === "compact";
        const engine = new MascotEngine(canvas, {
          framing: compact ? "bust" : "full",
          lowPower: lowPowerDevice(),
          maxFps: compact ? 30 : 60,
          reducedMotion: motion.matches,
          dark: latest.current.dark,
          gaze,
          onPoke: interactive ? () => latest.current.onPoke?.() : undefined,
          onContextLost: () => setFailed(true),
        });
        engineRef.current = engine;
        engine.setState(latest.current.state, latest.current.phase);
        const rect = box.getBoundingClientRect();
        engine.resize(rect.width, rect.height);

        const resize = new ResizeObserver(([entry]) => engine.resize(entry.contentRect.width, entry.contentRect.height));
        resize.observe(box);
        // Hors écran (conversation défilée, onglet masqué) : plus aucune image calculée.
        const visibility = new IntersectionObserver(([entry]) => engine.setVisible(entry.isIntersecting));
        visibility.observe(box);
        const onMotion = () => engine.setReducedMotion(motion.matches);
        motion.addEventListener("change", onMotion);
        if (motion.matches) engine.renderStill();
        setReady(true);

        cleanup = () => {
          resize.disconnect();
          visibility.disconnect();
          motion.removeEventListener("change", onMotion);
          engine.dispose();
          engineRef.current = null;
        };
      })
      .catch(() => !cancelled && setFailed(true));

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [variant, gaze, interactive]);

  useEffect(() => {
    engineRef.current?.setState(state, phase);
  }, [state, phase, ready]);

  useEffect(() => {
    engineRef.current?.setTheme(resolvedTheme === "dark");
  }, [resolvedTheme, ready]);

  const lastFeed = useRef(feed);
  useEffect(() => {
    if (feed > lastFeed.current) engineRef.current?.feed();
    lastFeed.current = feed;
  }, [feed]);

  const lastNudge = useRef(nudge);
  useEffect(() => {
    if (nudge > lastNudge.current) engineRef.current?.nudge();
    lastNudge.current = nudge;
  }, [nudge]);

  const live = ready && !failed;
  return (
    <div ref={boxRef} aria-hidden className={cn("relative shrink-0", className)}>
      <Image
        src={variant === "compact" ? bustStill : fullStill}
        alt=""
        fill
        unoptimized
        priority={priority}
        draggable={false}
        className={cn("object-contain transition-opacity duration-300 select-none", live && "opacity-0")}
      />
      {!failed && <canvas ref={canvasRef} className={cn("absolute inset-0 size-full transition-opacity duration-300", live ? "opacity-100" : "opacity-0")} />}
    </div>
  );
});
