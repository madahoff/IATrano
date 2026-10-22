"use client";

// Identité sonore de la mascotte : petits sons électroniques synthétisés avec Web Audio
// (aucun fichier à télécharger). Timbre commun pour la cohérence : sinus ou triangle avec une
// légère modulation de fréquence (« bloop » robotique), enveloppe douce, passe-bas, et un écho
// court très discret. Notes tirées d'une même gamme pentatonique.
//
// Règles : une seule voix à la fois (la suivante remplace la précédente en fondu), aucun son
// avant une interaction de l'utilisateur avec la page (politique d'autolecture des navigateurs),
// et les sons secondaires sont ignorés s'ils arrivent juste après un autre.

export type MascotSound = "wake" | "think" | "search" | "tick" | "done" | "error" | "ask" | "poke";

export type SoundPrefs = { enabled: boolean; volume: number };
export const SOUND_PREFS_KEY = "iatrano.mascot.sound";
export const DEFAULT_SOUND_PREFS: SoundPrefs = { enabled: true, volume: 0.5 };

export function parseSoundPrefs(raw: string | null): SoundPrefs {
  if (!raw) return DEFAULT_SOUND_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<SoundPrefs>;
    const volume = typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_SOUND_PREFS.volume;
    return { enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_SOUND_PREFS.enabled, volume };
  } catch {
    return DEFAULT_SOUND_PREFS;
  }
}

/** Sons secondaires : ignorés s'ils suivent de trop près un autre son. */
const MINOR = new Set<MascotSound>(["think", "tick", "poke"]);
const MIN_GAP_S = 0.5;
/** Gain maximal à volume 100 % : les sons restent en retrait de la lecture. */
const MAX_GAIN = 0.2;

type Blip = {
  at?: number;
  freq: number;
  /** Glissando vers cette fréquence. */
  to?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  /** Modulation de fréquence : rapport modulante/porteuse et indice (décroît pendant le son). */
  fm?: { ratio: number; index: number };
  cutoff?: number;
};

const SOUNDS: Record<MascotSound, Blip[]> = {
  // Mise en activité : glissando montant suivi d'une petite étincelle.
  wake: [
    { freq: 880, to: 1320, dur: 0.15, fm: { ratio: 2, index: 0.6 }, gain: 0.8 },
    { at: 0.09, freq: 1760, dur: 0.14, fm: { ratio: 3, index: 0.4 }, gain: 0.4 },
  ],
  // « Hmm » très bref et feutré.
  think: [{ freq: 523, to: 494, dur: 0.22, type: "triangle", fm: { ratio: 1.5, index: 0.3 }, gain: 0.45, cutoff: 2200 }],
  // Balayage : montée rapide puis ping.
  search: [
    { freq: 620, to: 1480, dur: 0.24, fm: { ratio: 3, index: 0.35 }, gain: 0.55 },
    { at: 0.2, freq: 1760, dur: 0.2, fm: { ratio: 2, index: 0.3 }, gain: 0.3 },
  ],
  // Tapotement : très court et doux (la hauteur varie un peu pour éviter la monotonie).
  tick: [{ freq: 1976, dur: 0.035, type: "triangle", gain: 0.16, cutoff: 3500 }],
  // Terminé : deux notes en tierce, timbre de petite cloche.
  done: [
    { freq: 988, dur: 0.16, fm: { ratio: 3.5, index: 0.9 }, gain: 0.55 },
    { at: 0.11, freq: 1319, dur: 0.38, fm: { ratio: 3.5, index: 0.9 }, gain: 0.6 },
  ],
  // Erreur : glissement descendant grave et rond, jamais strident.
  error: [{ freq: 392, to: 294, dur: 0.34, type: "triangle", fm: { ratio: 1, index: 0.4 }, gain: 0.6, cutoff: 1500 }],
  // Question : inflexion montante.
  ask: [{ freq: 659, to: 988, dur: 0.22, fm: { ratio: 2, index: 0.4 }, gain: 0.5 }],
  // Réaction au clic : trois gazouillis montants.
  poke: [
    { freq: 1175, dur: 0.06, fm: { ratio: 2, index: 0.5 }, gain: 0.4 },
    { at: 0.06, freq: 1568, dur: 0.06, fm: { ratio: 2, index: 0.5 }, gain: 0.4 },
    { at: 0.12, freq: 1976, dur: 0.09, fm: { ratio: 2, index: 0.5 }, gain: 0.35 },
  ],
};
const TICK_PITCHES = [1976, 2217, 2637];

class MascotAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voice: { gain: GainNode; end: number } | null = null;
  private lastStart = -Infinity;
  private prefs: SoundPrefs = DEFAULT_SOUND_PREFS;
  private activated = false;
  private listening = false;

  setPrefs(prefs: SoundPrefs) {
    this.prefs = prefs;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(prefs.volume * MAX_GAIN, this.ctx.currentTime, 0.05);
    if (!prefs.enabled) this.stop();
  }

  /** À appeler depuis un geste de l'utilisateur (clic) : autorise immédiatement la lecture. */
  activate() {
    this.activated = true;
  }

  /** Attend un geste de l'utilisateur avant d'autoriser le moindre son. */
  watchActivation() {
    if (this.activated || this.listening || typeof window === "undefined") return;
    const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
    if (nav.userActivation?.hasBeenActive) {
      this.activated = true;
      return;
    }
    this.listening = true;
    const on = () => {
      this.activated = true;
      this.listening = false;
      window.removeEventListener("pointerdown", on, true);
      window.removeEventListener("keydown", on, true);
      void this.ctx?.resume();
    };
    window.addEventListener("pointerdown", on, true);
    window.addEventListener("keydown", on, true);
  }

  play(name: MascotSound) {
    if (!this.prefs.enabled || this.prefs.volume <= 0 || !this.activated) return;
    const ctx = this.context();
    if (!ctx || ctx.state === "closed") return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const busy = this.voice !== null && now < this.voice.end;
    if (MINOR.has(name) && (busy || now - this.lastStart < MIN_GAP_S)) return;
    this.fadeVoice(now);

    const voice = ctx.createGain();
    voice.gain.value = 1;
    voice.connect(this.master!);
    let end = now;
    const blips = name === "tick" ? [{ ...SOUNDS.tick[0], freq: TICK_PITCHES[Math.floor(Math.random() * TICK_PITCHES.length)] }] : SOUNDS[name];
    for (const b of blips) end = Math.max(end, this.blip(ctx, voice, now + 0.01 + (b.at ?? 0), b));
    this.voice = { gain: voice, end };
    this.lastStart = now;
    // Libère le graphe une fois le son terminé (fondu compris).
    setTimeout(() => voice.disconnect(), (end - now) * 1000 + 300);
  }

  /** Coupe le son en cours (annulation, fin d'action) avec un fondu très court. */
  stop() {
    if (this.ctx) this.fadeVoice(this.ctx.currentTime);
  }

  private fadeVoice(now: number) {
    if (!this.voice || now >= this.voice.end) return;
    this.voice.gain.gain.cancelScheduledValues(now);
    this.voice.gain.gain.setTargetAtTime(0, now, 0.015);
    this.voice = null;
  }

  private context() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.prefs.volume * MAX_GAIN;
    // Écho court et discret : donne de l'espace sans traîner.
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.11;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.2;
    const wet = ctx.createGain();
    wet.gain.value = 0.16;
    master.connect(ctx.destination);
    master.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    return ctx;
  }

  private blip(ctx: AudioContext, out: AudioNode, t: number, b: Blip) {
    const end = t + b.dur;
    const osc = ctx.createOscillator();
    osc.type = b.type ?? "sine";
    osc.frequency.setValueAtTime(b.freq, t);
    if (b.to) osc.frequency.exponentialRampToValueAtTime(b.to, t + b.dur * 0.8);

    const env = ctx.createGain();
    const peak = b.gain ?? 0.5;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.012, b.dur / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = b.cutoff ?? 4200;
    filter.Q.value = 0.4;
    osc.connect(env).connect(filter).connect(out);

    const nodes: AudioScheduledSourceNode[] = [osc];
    if (b.fm) {
      const mod = ctx.createOscillator();
      mod.frequency.setValueAtTime(b.freq * b.fm.ratio, t);
      if (b.to) mod.frequency.exponentialRampToValueAtTime(b.to * b.fm.ratio, t + b.dur * 0.8);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(b.freq * b.fm.index, t);
      depth.gain.exponentialRampToValueAtTime(1, end);
      mod.connect(depth).connect(osc.frequency);
      nodes.push(mod);
    }
    for (const n of nodes) {
      n.start(t);
      n.stop(end + 0.02);
    }
    osc.onended = () => {
      env.disconnect();
      filter.disconnect();
    };
    return end + 0.02;
  }
}

/** Instance unique pour la page : un seul contexte audio, quelle que soit la vue. */
export const mascotAudio = new MascotAudio();
