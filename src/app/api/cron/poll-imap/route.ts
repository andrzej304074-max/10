import { NextResponse } from "next/server";

import { hasValidBearer } from "@/lib/auth/secret";
import { ConfigError, getCronConfig, getImapConfig } from "@/lib/config/env";
import { filterKnownMessageIds } from "@/lib/db/queries";
import { fetchRecentEmails } from "@/lib/mail/imap";
import { logger } from "@/lib/logger";
import { drainPendingEvents } from "@/lib/pipeline/deliver";
import { processInboundEmail, type ProcessOutcome } from "@/lib/pipeline/process-email";
import { TimeBudget } from "@/lib/time-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_DURATION_MS = maxDuration * 1000;

/** Ułamek budżetu przeznaczony na dokańczanie zaległości (reszta idzie na IMAP). */
const DRAIN_BUDGET_FRACTION = 0.4;

/** Ile czasu musi zostać, żeby w ogóle zaczynać przetwarzanie kolejnego maila. */
const PER_EMAIL_RESERVE_MS = 6_000;

/**
 * Ścieżka zapasowa — cron co 5 minut.
 *
 * Robi dwie rzeczy, w tej kolejności:
 *  1. dokańcza zdarzenia, którym w webhooku zabrakło czasu (`pending`) albo
 *     które poległy na błędzie przejściowym (`failed_retryable`),
 *  2. odpytuje IMAP o wiadomości z ostatnich N godzin i przepuszcza je przez
 *     dokładnie ten sam rdzeń co webhook.
 *
 * Faza pierwsza dostaje wydzielony kawałek budżetu, żeby długa kolejka
 * zaległości nie zagłodziła odpytania skrzynki.
 *
 * Uwierzytelnienie: `Authorization: Bearer $CRON_SECRET` — Vercel Cron dokłada
 * ten nagłówek automatycznie, gdy zmienna `CRON_SECRET` jest ustawiona
 * w projekcie.
 */
export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();

  let cronSecret: string;
  try {
    cronSecret = getCronConfig().CRON_SECRET;
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("cron.config_error", { group: error.group, issues: error.issues });
      return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 500 });
    }
    throw error;
  }

  if (!hasValidBearer(request, cronSecret)) {
    logger.warn("cron.unauthorized");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const budget = new TimeBudget(MAX_DURATION_MS - (Date.now() - startedAt), 5_000);
  const log = logger.child({ run: "poll-imap" });

  /* --- faza 1: zaległości --------------------------------------------------- */
  let drain;
  try {
    drain = await drainPendingEvents({ budget: budget.slice(DRAIN_BUDGET_FRACTION), log });
    if (drain.considered > 0) log.info("cron.drain_done", { ...drain });
  } catch (error) {
    log.error("cron.drain_failed", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown_error",
    });
    drain = { error: true };
  }

  /* --- faza 2: IMAP --------------------------------------------------------- */
  let imapConfig;
  try {
    imapConfig = getImapConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // IMAP jest opcjonalny — przy samym webhooku ta ścieżka po prostu nie działa.
      log.info("cron.imap_not_configured", { issues: error.issues });
      return NextResponse.json(
        { ok: true, drain, imap: { skipped: "not_configured" }, durationMs: Date.now() - startedAt },
        { status: 200 },
      );
    }
    throw error;
  }

  const outcomes: Partial<Record<ProcessOutcome, number>> = {};
  let processedCount = 0;
  let fetched;

  try {
    fetched = await fetchRecentEmails(imapConfig, {
      budget,
      isKnown: filterKnownMessageIds,
      log,
    });
  } catch (error) {
    log.error("cron.imap_failed", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown_error",
    });
    return NextResponse.json(
      {
        ok: false,
        drain,
        imap: { error: "imap_failed" },
        durationMs: Date.now() - startedAt,
      },
      { status: 200 },
    );
  }

  for (const message of fetched.messages) {
    if (!budget.hasAtLeast(PER_EMAIL_RESERVE_MS)) {
      log.warn("cron.budget_exhausted", {
        processed: processedCount,
        remaining: fetched.messages.length - processedCount,
      });
      break;
    }

    try {
      const result = await processInboundEmail(message, { budget, log });
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      processedCount += 1;
    } catch (error) {
      log.error("cron.process_failed", {
        messageId: message.messageId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown_error",
      });
    }
  }

  const backlog = fetched.backlog + (fetched.messages.length - processedCount);
  if (backlog > 0) {
    log.warn("cron.backlog_remaining", {
      backlog,
      hint: "Zwiększ IMAP_MAX_MESSAGES_PER_RUN albo skróć IMAP_LOOKBACK_HOURS.",
    });
  }

  const summary = {
    ok: true,
    drain,
    imap: {
      totalFound: fetched.totalFound,
      newFound: fetched.newFound,
      fetched: fetched.messages.length,
      processed: processedCount,
      backlog,
      outcomes,
    },
    durationMs: Date.now() - startedAt,
  };

  log.info("cron.done", summary);
  return NextResponse.json(summary, { status: 200 });
}
