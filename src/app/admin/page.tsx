import type { Metadata } from "next";
import { StatusView } from "@/components/admin/status-view";

export const metadata: Metadata = { title: "Administration" };

export default function AdminPage() {
  return <StatusView />;
}
