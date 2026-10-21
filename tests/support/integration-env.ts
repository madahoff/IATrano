import { vi } from "vitest";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret-123456";
(process.env as Record<string, string>).NODE_ENV = "test";

// Seul le contexte de requête Next.js est simulé ; base, sessions et handlers sont réels.
vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
