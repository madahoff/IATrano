import "server-only";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { runTool } from "../tools";

// Vidéo et audio via ffmpeg : durée et pistes (ffprobe), images clés aux changements de scène (au moins une
// par minute, plafonnées), piste audio mono 16 kHz découpée en tranches de 5 minutes pour la transcription.

export type MediaProbe = { durationMs: number; hasVideo: boolean; hasAudio: boolean; width?: number; height?: number; metadata: Record<string, string> };

export async function probeMedia(file: string, signal?: AbortSignal): Promise<MediaProbe> {
  const { stdout } = await runTool("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000, signal });
  const data = JSON.parse(stdout.toString("utf8")) as { format?: { duration?: string; tags?: Record<string, string> }; streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }> };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const durationSec = Number(data.format?.duration ?? video?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Durée du média illisible.");
  const tags = Object.fromEntries(Object.entries(data.format?.tags ?? {}).filter(([k]) => /^(title|artist|album|comment|date|creation_time|language)$/i.test(k)));
  return { durationMs: Math.round(durationSec * 1000), hasVideo: Boolean(video), hasAudio: Boolean(data.streams?.some((s) => s.codec_type === "audio")), width: video?.width, height: video?.height, metadata: tags };
}

export const AUDIO_CHUNK_SEC = 300;

/** Découpe l'audio en tranches MP3 mono 16 kHz ; renvoie les chemins dans l'ordre. */
export async function extractAudioChunks(file: string, outDirAbs: string, durationMs: number, signal?: AbortSignal): Promise<string[]> {
  await runTool(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "segment", "-segment_time", String(AUDIO_CHUNK_SEC), "-reset_timestamps", "1", path.join(outDirAbs, "audio-%04d.mp3")],
    { timeoutMs: Math.max(120_000, durationMs / 2), signal },
  );
  return (await readdir(outDirAbs)).filter((f) => /^audio-\d{4}\.mp3$/.test(f)).sort().map((f) => path.join(outDirAbs, f));
}

/**
 * Images clés : premier plan, chaque changement de scène marqué (score > seuil) et au moins une image par
 * intervalle maximal. Les horodatages viennent du filtre showinfo (jamais estimés).
 */
export async function extractKeyframes(file: string, outDirAbs: string, durationMs: number, opts: { maxFrames: number; maxGapSec?: number; threshold?: number; signal?: AbortSignal }): Promise<Array<{ file: string; ms: number }>> {
  const durationSec = durationMs / 1000;
  // Vidéo longue : intervalle minimal élargi pour respecter le plafond d'images.
  const maxGap = Math.max(opts.maxGapSec ?? 60, Math.ceil(durationSec / opts.maxFrames));
  const minGap = Math.max(2, Math.floor(durationSec / (opts.maxFrames * 2)));
  const select = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${maxGap})+gt(scene\\,${opts.threshold ?? 0.32})*gte(t-prev_selected_t\\,${minGap})',showinfo,scale='min(1280,iw)':-2`;
  const { stderr } = await runTool(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-y", "-i", file, "-an", "-vf", select, "-vsync", "vfr", "-frames:v", String(opts.maxFrames), "-q:v", "3", path.join(outDirAbs, "frame-%05d.jpg")],
    { timeoutMs: Math.max(180_000, durationMs), signal: opts.signal, maxBuffer: 64 * 1024 * 1024 },
  );
  const times = [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  const files = (await readdir(outDirAbs)).filter((f) => /^frame-\d{5}\.jpg$/.test(f)).sort();
  return files.map((f, i) => ({ file: path.join(outDirAbs, f), ms: times[i] ?? Math.round((i * durationMs) / Math.max(1, files.length)) }));
}
