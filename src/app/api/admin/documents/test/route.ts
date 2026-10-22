import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { testDocumentServices } from "@/lib/documents/admin";

export const POST = route(async () => {
  await requireApiUser("settings:manage");
  return json({ results: await testDocumentServices() });
});
