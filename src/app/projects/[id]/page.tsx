import { ProjectDetailView } from "@/components/projects/project-detail-view";
import { requirePageUser } from "@/lib/auth/guard";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageUser();
  return <ProjectDetailView projectId={(await params).id} />;
}
