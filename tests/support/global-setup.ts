import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL est requis pour les tests d'intégration (ex. postgresql://iatrano:iatrano@localhost:5442/iatrano_test).");
  if (!/test/i.test(url)) throw new Error("Par sécurité, TEST_DATABASE_URL doit désigner une base dont le nom contient « test ».");
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}
