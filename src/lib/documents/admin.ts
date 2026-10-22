import "server-only";
import { db } from "@/lib/db";
import { getModels } from "@/lib/llm/discovery";
import { getAppSettings } from "@/lib/settings/service";
import { embeddingConfig, testEmbeddings } from "./embeddings";
import { getDocumentSettings } from "./settings";
import { storageRoot } from "./storage";
import { toolPath, toolsStatus } from "./tools";
import { transcriptionEndpoint } from "./transcribe";
import { workerEnabled } from "./worker";

// Vue d'administration : réglages, capacités réellement disponibles (outils, modèles), file de traitement.

export async function getDocumentAdminView() {
  const [settings, app, tools, models, queue, totals] = await Promise.all([
    getDocumentSettings(),
    getAppSettings(),
    toolsStatus(),
    getModels().catch(() => null),
    db.documentJob.groupBy({ by: ["status"], _count: { _all: true } }),
    db.projectDocument.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true } }),
  ]);
  const visionModels = models?.models.filter((m) => m.capabilities.vision === "yes").map((m) => m.id) ?? [];
  return {
    settings,
    capabilities: {
      tools,
      ocrEngine: tools.tesseract ? "tesseract (binaire système)" : "tesseract.js (WebAssembly intégré)",
      visionModels,
      llmModels: models?.models.map((m) => m.id) ?? [],
      defaultModel: app.defaultModel,
      worker: workerEnabled(),
      storage: storageRoot(),
    },
    queue: Object.fromEntries(queue.map((q) => [q.status, q._count._all])),
    totals: { documents: totals._count._all, bytes: totals._sum.sizeBytes ?? 0 },
  };
}

/** Teste les services configurés (embeddings, transcription, vision) sans rien enregistrer. */
export async function testDocumentServices() {
  const [settings, app] = await Promise.all([getDocumentSettings(), getAppSettings()]);
  const results: Array<{ service: string; ok: boolean; detail: string }> = [];
  const cfg = embeddingConfig(app, settings);
  if (cfg) {
    try {
      const r = await testEmbeddings(cfg);
      results.push({ service: "Embeddings", ok: true, detail: `${cfg.model} : vecteurs de ${r.dimensions} dimensions en ${r.latencyMs} ms` });
    } catch (err) {
      results.push({ service: "Embeddings", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  } else results.push({ service: "Embeddings", ok: false, detail: "Aucun modèle configuré : recherche lexicale (BM25) uniquement." });
  if (settings.transcriptionUrl) {
    const url = transcriptionEndpoint(settings.transcriptionUrl);
    try {
      const health = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(5000) }).catch(() => null);
      const res = health ?? (await fetch(url, { method: "OPTIONS", signal: AbortSignal.timeout(5000) }));
      results.push({ service: "Transcription", ok: res.status < 500, detail: `${url} répond (HTTP ${res.status})` });
    } catch (err) {
      results.push({ service: "Transcription", ok: false, detail: `${url} injoignable : ${err instanceof Error ? err.message : String(err)}` });
    }
  } else results.push({ service: "Transcription", ok: false, detail: "Aucun service configuré : l'audio des vidéos n'est pas transcrit." });
  const models = await getModels().catch(() => null);
  if (settings.visionModel) {
    const m = models?.models.find((x) => x.id === settings.visionModel);
    results.push({ service: "Vision", ok: Boolean(m && m.capabilities.vision !== "no"), detail: m ? `${m.id} (vision : ${m.capabilities.vision === "yes" ? "déclarée" : m.capabilities.vision === "no" ? "absente" : "non vérifiable"})` : `${settings.visionModel} n'est pas installé sur le serveur IA.` });
  } else results.push({ service: "Vision", ok: false, detail: "Aucun modèle vision-langage : les images sont lues par OCR seulement." });
  results.push({ service: "PDF (poppler)", ok: Boolean(await toolPath("pdftotext")), detail: (await toolPath("pdftotext")) ? "pdftotext, pdfinfo, pdftoppm disponibles" : "poppler-utils absent : les PDF ne peuvent pas être traités" });
  results.push({ service: "Vidéo (ffmpeg)", ok: Boolean(await toolPath("ffmpeg")), detail: (await toolPath("ffmpeg")) ? "ffmpeg et ffprobe disponibles" : "ffmpeg absent : vidéos et audio non pris en charge" });
  return results;
}
