import { defineConfig } from "drizzle-kit";

/**
 * `drizzle-kit generate` działa offline — porównuje schemat z migawką w ./drizzle
 * i nie potrzebuje bazy. Prawdziwego connection stringa wymagają dopiero
 * `db:migrate` (skrypt w scripts/migrate.ts) oraz `db:studio`. Dlatego zamiast
 * rzucać wyjątkiem, podstawiamy tu jawny placeholder.
 */
const PLACEHOLDER = "postgres://user:password@localhost:5432/placeholder";

const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? PLACEHOLDER;

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
