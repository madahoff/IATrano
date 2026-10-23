import type { Metadata } from "next";
import { DocumentDetailView } from "@/components/documents/document-detail-view";
import { requirePageUser } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Document" };

export default async function DocumentPage({ params }: { params: Promise<{ id: string; documentId: string }> }) {
  await requirePageUser();
  const p = await params;
  return <DocumentDetailView projectId={p.id} documentId={p.documentId} />;
}
