// Types partagés serveur/navigateur pour les artifacts.

export type ArtifactRef = {
  id: string;
  key: string;
  version: number;
  title: string;
  valid: boolean;
  issues: string[];
  origin: "GENERATED" | "EDITED" | "REPAIRED";
};

export type ArtifactDTO = ArtifactRef & {
  code: string;
  conversationId: string;
  messageId: string;
  runtimeError: string | null;
  autoRepairUsed: boolean;
  createdAt: string;
  /** Toutes les versions de cet artifact (navigation v1 / v2 / v3). */
  versions: Array<Pick<ArtifactRef, "id" | "version" | "origin" | "valid"> & { createdAt: string }>;
};

export function toArtifactRef(a: ArtifactRef): ArtifactRef {
  return { id: a.id, key: a.key, version: a.version, title: a.title, valid: a.valid, issues: a.issues, origin: a.origin };
}
