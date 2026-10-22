import type { DocumentRetrieval } from "@prisma/client";
import type { CitationCheckDTO, DocSourceDTO, DocumentRetrievalDTO } from "./types";

/** Restitue la trace documentaire d'une réponse ; les entrées mal formées sont ignorées plutôt qu'affichées. */
export function toDocumentRetrievalDTO(r: DocumentRetrieval): DocumentRetrievalDTO {
  const sources = (Array.isArray(r.sources) ? r.sources : []).filter((s): s is DocSourceDTO => {
    const x = s as Partial<DocSourceDTO> | null;
    return Boolean(x && typeof x.n === "number" && typeof x.documentId === "string" && typeof x.name === "string");
  });
  const checks = (Array.isArray(r.checks) ? r.checks : []).filter((c): c is CitationCheckDTO => typeof (c as Partial<CitationCheckDTO> | null)?.n === "number");
  const plan = (r.plan ?? {}) as { intent?: string };
  return { intent: plan.intent ?? "lookup", queries: r.queries, sources, cited: r.cited, checks, limitations: r.limitations };
}
