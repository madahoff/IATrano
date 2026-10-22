"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { soundForTransition, tickInterval } from "@/lib/mascot/sound-policy";
import { mascotAudio, parseSoundPrefs, SOUND_PREFS_KEY, type SoundPrefs } from "./sounds";
import type { MascotView } from "./use-mascot";

/** Préférence sonore de la mascotte, mémorisée sur cet appareil (Paramètres → Apparence). */
export function useSoundPrefs(): [SoundPrefs, (prefs: SoundPrefs) => void] {
  const [raw, setRaw] = useLocalStorage(SOUND_PREFS_KEY);
  const prefs = useMemo(() => parseSoundPrefs(raw), [raw]);
  const set = useCallback((p: SoundPrefs) => setRaw(JSON.stringify(p)), [setRaw]);
  return [prefs, set];
}

/**
 * Sons de la mascotte, déclenchés uniquement par les changements d'état réels (jamais au
 * montage ni à un simple rendu). Pendant la rédaction, quelques tapotements espacés suivent
 * l'arrivée effective du texte, puis s'arrêtent sur les longues réponses.
 */
export function useMascotSounds(mascot: MascotView) {
  const [prefs] = useSoundPrefs();
  useEffect(() => {
    mascotAudio.setPrefs(prefs);
  }, [prefs]);
  useEffect(() => {
    mascotAudio.watchActivation();
    return () => mascotAudio.stop();
  }, []);

  const prev = useRef<Pick<MascotView, "state" | "phase"> | null>(null);
  const writingSince = useRef(0);
  const nextTick = useRef(0);
  useEffect(() => {
    const next = { state: mascot.state, phase: mascot.phase };
    const before = prev.current;
    prev.current = next;
    if (next.state === "generating" && before?.state !== "generating") {
      writingSince.current = performance.now();
      nextTick.current = writingSince.current + 400;
    }
    if (!before) return;
    const cue = soundForTransition(before, next);
    if (cue === "stop") mascotAudio.stop();
    else if (cue) mascotAudio.play(cue);
  }, [mascot.state, mascot.phase]);

  useEffect(() => {
    if (mascot.state !== "generating" || mascot.feed === 0) return;
    const now = performance.now();
    if (now < nextTick.current) return;
    const interval = tickInterval((now - writingSince.current) / 1000);
    if (!interval) return;
    mascotAudio.play("tick");
    nextTick.current = now + (interval[0] + Math.random() * (interval[1] - interval[0])) * 1000;
  }, [mascot.feed, mascot.state]);
}
