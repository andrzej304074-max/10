import { after, NextResponse } from "next/server";

import { ConfigError } from "@/lib/config/env";
import { logger } from "@/lib/logger";
import { getInboundAdapter } from "@/lib/mail/providers";
import { processInboundEmail } from "@/lib/pipeline/process-email";
import { TimeBudget } from "@/lib/time-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Musi zgadzać się z `maxDuration` powyżej — z tego liczymy budżet czasu. */
const MAX_DURATION_MS = maxDuration * 1000;

/**
 * Webhook poczty przychodzącej — główna ścieżka.
 *
 * Sekwencja:
 *  1. weryfikacja podpisu (Svix dla Resend, HMAC dla Mailguna) — BEZWZGLĘDNIE
 *     przed jakimkolwiek przetwarzaniem treści; brak lub zły podpis to 401,
 *  2. natychmiastowe 200 — dostawca nie może czekać na Meta ani na bazę,
 *  3. właściwe przetwarzanie w `after()`, już po odesłaniu odpowiedzi.
 *
 * `after()` to odpowiednik `waitUntil` w App Routerze Next.js — praca trwa dalej
 * w tej samej funkcji serverless, ale nie blokuje odpowiedzi. Budżet czasu
 * liczymy od początku żądania, żeby zdążyć zapisać wynik do bazy przed
 * wygaśnięciem funkcji.
 */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();

  let adapter;
  try {
    adapter = getInboundAdapter();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("inbound.config_error", { group: error.group, issues: error.issues });
      return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 500 });
    }
    throw error;
  }

  const verification = await adapter.readAndVerify(request);

  if (!verification.ok) {
    // Zdarzenia, które po prostu nas nie dotyczą (np. `email.sent` od Resend),
    // kwitujemy dwusetką — inaczej dostawca ponawiałby je w nieskończoność.
    if (verification.reason.startsWith("ignored_event_type")) {
      logger.info("inbound.ignored", { provider: adapter.name, reason: verification.reason });
      return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
    }

    logger.warn("inbound.rejected", {
      provider: adapter.name,
      status: verification.status,
      reason: verification.reason,
    });
    return NextResponse.json(
      { ok: false, error: verification.status === 401 ? "unauthorized" : "bad_request" },
      { status: verification.status },
    );
  }

  const email = verification.email;

  logger.info("inbound.accepted", {
    provider: adapter.name,
    messageId: email.messageId,
    verifyMs: Date.now() - startedAt,
  });

  after(async () => {
    const budget = new TimeBudget(MAX_DURATION_MS - (Date.now() - startedAt), 5_000);

    try {
      const result = await processInboundEmail(email, { budget });
      logger.info("inbound.processed", {
        messageId: email.messageId,
        outcome: result.outcome,
        eventId: result.eventId,
        reason: result.reason,
        totalMs: Date.now() - startedAt,
      });
    } catch (error) {
      // Wyjątek w `after()` nie może wywrócić odpowiedzi (ta już poszła),
      // ale musi zostawić ślad — inaczej lead zniknąłby po cichu.
      logger.error("inbound.processing_failed", {
        messageId: email.messageId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown_error",
      });
    }
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
