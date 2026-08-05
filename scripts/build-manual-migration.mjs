/**
 * Składa `scripts/manual-migration.sql` — wersję migracji do wklejenia
 * w edytorze SQL bazy, bez Node.js i bez klonowania repozytorium.
 *
 *   node scripts/build-manual-migration.mjs
 *
 * Uruchom po każdym `npm run db:generate`, żeby plik nie rozjechał się
 * ze schematem.
 *
 * Do wygenerowanego SQL-a dokładany jest wpis w rejestrze migracji Drizzle
 * (`drizzle.__drizzle_migrations`). Bez niego późniejsze `npm run db:migrate`
 * próbowałoby wykonać tę samą migrację po raz drugi i wywaliłoby się na
 * „relation already exists”. Hash liczony jest tak samo jak w drizzle-orm:
 * SHA-256 z całej treści pliku .sql.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const JOURNAL = "drizzle/meta/_journal.json";
const OUTPUT = "scripts/manual-migration.sql";

const journal = JSON.parse(readFileSync(JOURNAL, "utf8"));

const parts = [
  `-- ============================================================================
--  Migracja ręczna — do wklejenia w edytorze SQL bazy danych
--  (Vercel → Storage → Twoja baza → Query, albo konsola Neon → SQL Editor)
--
--  Odpowiednik polecenia \`npm run db:migrate\`, ale bez Node.js i bez
--  klonowania repozytorium. Wklej CAŁOŚĆ i uruchom raz.
--
--  Ostatni blok wpisuje migracje do rejestru Drizzle. Dzięki temu, jeśli
--  kiedyś uruchomisz \`npm run db:migrate\` z komputera, narzędzie rozpozna,
--  że są już wykonane, i ich nie powtórzy.
--
--  Plik generowany — nie edytuj ręcznie:
--      npm run db:generate && node scripts/build-manual-migration.mjs
-- ============================================================================
`,
];

const registry = [];

for (const entry of journal.entries) {
  const sql = readFileSync(`drizzle/${entry.tag}.sql`, "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");

  parts.push(`\n-- ---------------------------------------------------------------------------
--  ${entry.tag}
-- ---------------------------------------------------------------------------\n\n${sql.trimEnd()}\n`);

  registry.push(
    `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")\n` +
      `SELECT '${hash}', ${entry.when}\n` +
      `WHERE NOT EXISTS (\n` +
      `\tSELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '${hash}'\n` +
      `);`,
  );
}

parts.push(`
-- ============================================================================
--  Rejestr migracji Drizzle
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS "drizzle";

CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
\tid SERIAL PRIMARY KEY,
\thash text NOT NULL,
\tcreated_at bigint
);

${registry.join("\n\n")}
`);

writeFileSync(OUTPUT, parts.join(""), "utf8");
console.log(`✔ ${OUTPUT} — ${journal.entries.length} migracja/e`);
