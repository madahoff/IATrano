import { describe, expect, it } from "vitest";
import { soundForTransition, tickInterval } from "@/lib/mascot/sound-policy";
import { DEFAULT_SOUND_PREFS, parseSoundPrefs } from "@/components/mascot/sounds";

const cue = (from: string, to: string, phases: [string?, string?] = []) =>
  soundForTransition({ state: from as never, phase: phases[0] as never }, { state: to as never, phase: phases[1] as never });

describe("soundForTransition", () => {
  it("activation à l'entrée en activité, pas en cours de route", () => {
    expect(cue("idle", "listening")).toBe("wake");
    expect(cue("completed", "listening")).toBe("wake");
    expect(cue("thinking", "listening")).toBeNull();
  });

  it("réflexion seulement juste après l'écoute", () => {
    expect(cue("listening", "thinking")).toBe("think");
    expect(cue("searching", "thinking")).toBeNull();
  });

  it("recherche : un son au démarrage, silence entre les sous-étapes", () => {
    expect(cue("thinking", "searching", [undefined, "scan"])).toBe("search");
    expect(cue("searching", "searching", ["scan", "read"])).toBeNull();
  });

  it("fin, erreur et question", () => {
    expect(cue("generating", "completed")).toBe("done");
    expect(cue("generating", "error")).toBe("error");
    expect(cue("generating", "asking")).toBe("ask");
  });

  it("annulation : retour au repos depuis une activité → arrêt du son", () => {
    expect(cue("generating", "idle")).toBe("stop");
    expect(cue("searching", "idle")).toBe("stop");
    expect(cue("completed", "idle")).toBeNull();
  });

  it("aucun son sans changement d'état", () => {
    expect(cue("idle", "idle")).toBeNull();
    expect(cue("generating", "generating")).toBeNull();
  });
});

describe("tickInterval", () => {
  it("de plus en plus espacés, puis plus aucun", () => {
    expect(tickInterval(2)).toEqual([0.55, 1.0]);
    expect(tickInterval(12)![0]).toBeGreaterThan(1);
    expect(tickInterval(40)).toBeNull();
  });
});

describe("parseSoundPrefs", () => {
  it("valeurs par défaut et bornes", () => {
    expect(parseSoundPrefs(null)).toEqual(DEFAULT_SOUND_PREFS);
    expect(parseSoundPrefs("pas du json")).toEqual(DEFAULT_SOUND_PREFS);
    expect(parseSoundPrefs(JSON.stringify({ enabled: false, volume: 3 }))).toEqual({ enabled: false, volume: 1 });
    expect(parseSoundPrefs(JSON.stringify({ volume: 0.3 }))).toEqual({ enabled: true, volume: 0.3 });
  });
});
