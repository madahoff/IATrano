import { ProjectsView } from "@/components/projects/projects-view";
import { requirePageUser } from "@/lib/auth/guard";

export default async function ProjectsPage() {
  await requirePageUser();
  return <ProjectsView />;
}
