import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";

import { getDbConfig } from "@/lib/config/env";

import * as schema from "./schema";

export type Database = NeonHttpDatabase<typeof schema>;

let cached: Database | undefined;

/**
 * Klient bazy oparty o sterownik HTTP Neona.
 *
 * Dlaczego HTTP, a nie pula połączeń TCP: w środowisku serverless każda
 * instancja funkcji trzymałaby własne połączenie, a Neon szybko wyczerpałby
 * limit. Sterownik HTTP wykonuje pojedyncze zapytanie w jednym round-tripie
 * i nie zostawia po sobie niczego do zamknięcia.
 *
 * Konsekwencja: brak transakcji interaktywnych. Nie potrzebujemy ich —
 * idempotencja opiera się na `INSERT ... ON CONFLICT DO NOTHING`, które samo
 * w sobie jest atomowe.
 */
export function getDb(): Database {
  if (!cached) {
    const { POSTGRES_URL } = getDbConfig();
    cached = drizzle(neon(POSTGRES_URL), { schema });
  }
  return cached;
}

/** Podmiana klienta w testach. */
export function __setDbForTests(db: Database | undefined): void {
  cached = db;
}
