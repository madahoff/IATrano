import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tests d'intégration : base PostgreSQL réelle (TEST_DATABASE_URL), migrée par globalSetup (migrate deploy, non destructif). Créez la base une fois :
//   docker exec iatrano-dev-db-1 psql -U iatrano -c "CREATE DATABASE iatrano_test"
export default defineConfig({
  resolve: {
    alias: {
      "@": r("./src"),
      "server-only": r("./tests/support/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/support/global-setup.ts"],
    setupFiles: ["./tests/support/integration-env.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
