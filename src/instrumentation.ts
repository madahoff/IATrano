export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureBootstrapped } = await import("@/lib/bootstrap");
    await ensureBootstrapped();
    // File de traitement des documents (reprend aussi les traitements interrompus par un redémarrage).
    const { startDocumentWorker } = await import("@/lib/documents/worker");
    startDocumentWorker();
  }
}
