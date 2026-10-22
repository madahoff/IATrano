import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchWithTimeout, readErrorBody } from "@/lib/llm/stream-utils";

// Transcription audio via un endpoint compatible OpenAI (/v1/audio/transcriptions, verbose_json) :
// faster-whisper (deploy/whisper), speaches, LocalAI, whisper.cpp server… Horodatage par segment conservé.

export type TranscriptSegment = { startMs: number; endMs: number; text: string; confidence: number | null; uncertain: boolean };

type VerboseJson = { text?: string; language?: string; segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }> };

export function transcriptionEndpoint(url: string) {
  const base = url.replace(/\/+$/, "");
  return /\/audio\/transcriptions$/.test(base) ? base : /\/v1$/.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

export async function transcribeFile(opts: { url: string; model: string | null; file: string; offsetMs: number; signal?: AbortSignal; timeoutMs?: number }): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(await readFile(opts.file))], { type: "audio/mpeg" }), path.basename(opts.file));
  form.set("model", opts.model || "whisper-1");
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const endpoint = transcriptionEndpoint(opts.url);
  const res = await fetchWithTimeout(endpoint, { method: "POST", body: form }, { baseUrl: endpoint, timeoutMs: opts.timeoutMs ?? 900_000, signal: opts.signal });
  if (!res.ok) throw new Error(`Transcription (${res.status}) : ${await readErrorBody(res)}`);
  const data = (await res.json()) as VerboseJson;
  const segments = (data.segments ?? []).map((s) => {
    const confidence = typeof s.avg_logprob === "number" ? Math.exp(s.avg_logprob) : null;
    return {
      startMs: Math.round(s.start * 1000) + opts.offsetMs,
      endMs: Math.round(s.end * 1000) + opts.offsetMs,
      text: s.text.trim(),
      confidence,
      uncertain: (confidence !== null && confidence < 0.45) || (s.no_speech_prob ?? 0) > 0.6,
    };
  });
  if (!segments.length && data.text?.trim()) segments.push({ startMs: opts.offsetMs, endMs: opts.offsetMs, text: data.text.trim(), confidence: null, uncertain: false });
  return { segments: segments.filter((s) => s.text), language: data.language ?? null };
}

export function formatTimestamp(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Texte canonique d'une tranche transcrite : un horodatage par phrase ; les passages incertains sont signalés. */
export function transcriptUnitText(heading: string, segments: TranscriptSegment[]) {
  return [`## ${heading}`, ...segments.map((s) => `[${formatTimestamp(s.startMs)}] ${s.text}${s.uncertain ? " [transcription incertaine]" : ""}`)].join("\n\n");
}
