import { NextResponse } from "next/server";

import { hasValidBearer } from "@/lib/auth/secret";
import { ConfigError, getCronConfig, getMetaConfig } from "@/lib/config/env";
import { truncate } from "@/lib/hashing/mask";
import { logger, redact } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Diagnostyka konfiguracji Meta.
 *
 * Odpowiada na pytanie, którego nie da się rozstrzygnąć z poziomu Menedżera
 * zdarzeń: **czy zestaw danych, do którego wysyłamy, to ten sam, na który
 * patrzysz w przeglądarce**.
 *
 * Najważniejsze pole odpowiedzi to `last_fired_time` — znacznik ostatniego
 * zdarzenia zarejestrowanego przez Meta w tym zestawie. Jeśli jest świeży,
 * a interfejs nic nie pokazuje, to problem leży wyłącznie w wyświetlaniu.
 * Jeśli jest stary albo pusty, zdarzenia trafiają gdzie indziej.
 *
 * Uwierzytelnienie: `Authorization: Bearer $CRON_SECRET`.
 * Token dostępu nie pojawia się w odpowiedzi ani w logach.
 */
export async function GET(request: Request): Promise<Response> {
  let cronSecret: string;
  try {
    cronSecret = getCronConfig().CRON_SECRET;
  } catch (error) {
    if (error instanceof ConfigError) {
      return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 500 });
    }
    throw error;
  }

  if (!hasValidBearer(request, cronSecret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let meta: ReturnType<typeof getMetaConfig>;
  try {
    meta = getMetaConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return NextResponse.json(
        { ok: false, error: "misconfigured", issues: error.issues },
        { status: 500 },
      );
    }
    throw error;
  }

  const base = `https://graph.facebook.com/${meta.META_API_VERSION}`;

  /** Wywołuje Graph API i zwraca sparsowaną odpowiedź razem z kodem HTTP. */
  async function graph(path: string): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("access_token", meta.META_ACCESS_TOKEN);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();

      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status, body: truncate(redact(text), 500) };
      }
    } catch (error) {
      return {
        status: 0,
        body: { error: error instanceof Error ? error.name : "network_error" },
      };
    }
  }

  const [dataset, identity] = await Promise.all([
    // `last_fired_time` mówi, kiedy Meta ostatnio zarejestrowała zdarzenie
    // w tym zestawie — to jest sedno tej diagnostyki.
    graph(
      `/${meta.META_DATASET_ID}?fields=id,name,last_fired_time,is_unavailable,owner_business{id,name}`,
    ),
    // Tożsamość tokenu — pokazuje, w czyim imieniu wysyłamy.
    graph(`/me?fields=id,name`),
  ]);

  logger.info("dev.meta_info", {
    datasetStatus: dataset.status,
    identityStatus: identity.status,
  });

  return NextResponse.json(
    {
      ok: true,
      config: {
        datasetId: meta.META_DATASET_ID,
        apiVersion: meta.META_API_VERSION,
        testMode: meta.META_TEST_MODE,
        testEventCode: meta.META_TEST_MODE ? meta.META_TEST_EVENT_CODE : null,
        eventsEndpoint: `${base}/${meta.META_DATASET_ID}/events`,
      },
      /** Zestaw danych widziany oczami Meta — nazwa i czas ostatniego zdarzenia. */
      dataset,
      /** Tożsamość, do której należy token. */
      identity,
      hint:
        "Porównaj dataset.body.name z nazwą zestawu, który masz otwarty w Menedżerze " +
        "zdarzeń. Jeśli last_fired_time jest świeży, zdarzenia docierają i problem " +
        "dotyczy wyłącznie wyświetlania.",
    },
    { status: 200 },
  );
}
