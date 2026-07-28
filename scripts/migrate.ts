/**
 * Uruchamia migracje z katalogu ./drizzle.
 *
 *   npm run db:migrate
 *
 * Connection string bierzemy z POSTGRES_URL (tak nazywa go integracja
 * Vercel Postgres / Neon). Lokalnie najprościej pobrać go poleceniem
 * `vercel env pull .env.local`.
 *
 * Skrypt jest idempotentny — Drizzle trzyma w bazie tabelę z listą już
 * wykonanych migracji, więc powtórne uruchomienie niczego nie zepsuje.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

/** Minimalny czytnik .env — bez dodatkowej zależności. */
function loadEnvFile(filename: string): void {
  try {
    const content = readFileSync(resolve(process.cwd(), filename), "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match?.[1]) continue;
      if (process.env[match[1]] !== undefined) continue;

      let value = (match[2] ?? "").trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // Brak pliku to normalna sytuacja — na Vercelu zmienne są w środowisku.
  }
}

async function main(): Promise<void> {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;

  if (!url) {
    console.error(
      "\n✖ Brak POSTGRES_URL.\n\n" +
        "  Lokalnie:  vercel env pull .env.local\n" +
        "  Albo ręcznie w .env.local:  POSTGRES_URL=postgres://...\n",
    );
    process.exit(1);
  }

  console.log("→ Uruchamiam migracje…");

  const db = drizzle(neon(url));
  await migrate(db, { migrationsFolder: "./drizzle" });

  console.log("✔ Migracje wykonane.");
}

main().catch((error: unknown) => {
  console.error("✖ Migracja nie powiodła się:", error);
  process.exit(1);
});
