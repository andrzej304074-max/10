import { NextResponse } from "next/server";

import { describeConfig } from "@/lib/config/env";
import { getHealthSummary, pingDatabase } from "@/lib/db/queries";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Stan aplikacji.
 *
 * Odpowiedź zawiera wyłącznie dane zagregowane i nazwy grup konfiguracji —
 * ani jednej wartości zmiennej środowiskowej i ani jednego pola osobowego.
 * Dlatego endpoint może zostać publiczny; jeśli mimo to chcesz go schować,
 * dołóż regułę w `next.config.ts` albo w ustawieniach projektu.
 */
export async function GET(): Promise<Response> {
  const startedAt = Date.now();

  // Zwracamy same flagi „skonfigurowane / nie” — bez treści komunikatów,
  // żeby nie wyciekły nazwy hostów ani inne szczegóły środowiska.
  const config = Object.fromEntries(describeConfig().map((group) => [group.group, group.ok]));

  let database: { ok: boolean; error?: string } = { ok: false };
  let summary: Awaited<ReturnType<typeof getHealthSummary>> | undefined;

  try {
    await pingDatabase();
    database = { ok: true };
    summary = await getHealthSummary(24);
  } catch (error) {
    database = { ok: false, error: error instanceof Error ? error.name : "unknown_error" };
    logger.error("health.database_unreachable", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown_error",
    });
  }

  const healthy = database.ok && config.meta === true && config.db === true;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      time: new Date().toISOString(),
      database,
      config,
      last24h: summary,
      durationMs: Date.now() - startedAt,
    },
    { status: healthy ? 200 : 503 },
  );
}
