import { getAppConfig, getMetaConfig } from "@/lib/config/env";
import {
  getLeadEvent,
  listRetryableEvents,
  resolveDeadLetter,
  updateLeadEventResult,
  upsertDeadLetter,
} from "@/lib/db/queries";
import type { LeadEventRow } from "@/lib/db/schema";
import { sendLeadEvent, type SendResult } from "@/lib/meta/client";
import { isEventTooOld } from "@/lib/meta/event";
import type { MetaEventsRequestBody } from "@/lib/meta/types";
import { logger, type Logger } from "@/lib/logger";
import type { TimeBudget } from "@/lib/time-budget";

export type DeliveryOutcome =
  /** Przyjęte przez Meta. */
  | "sent"
  /** Zabrakło budżetu czasu — zdarzenie czeka jako `pending`, dokończy je cron. */
  | "pending"
  /** Błąd przejściowy — cron ponowi przy następnym przebiegu. */
  | "retry_scheduled"
  /** Błąd trwały albo wyczerpane próby — wpis w dead-letter. */
  | "dead";

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  eventId: string;
  attempts: number;
  status?: number;
  reason?: string;
}

export interface DeliverOptions {
  budget: TimeBudget;
  log?: Logger;
  /** Wstrzykiwane w testach. */
  sendImpl?: typeof sendLeadEvent;
}

/**
 * Wysyła zdarzenie i utrwala wynik.
 *
 * Mapowanie wyniku klienta HTTP na stan w bazie:
 *   sent              → `sent`             (+ zamknięcie wpisu w dead-letter, jeśli był)
 *   permanent_failure → `dead`             (+ dead-letter; 4xx nie ma sensu ponawiać)
 *   retryable_failure → `failed_retryable` (albo `dead`, gdy skończyły się próby)
 *   budget_exhausted  → `pending`          (cron dokończy)
 */
export async function deliverEvent(
  params: {
    eventId: string;
    messageId: string;
    body: MetaEventsRequestBody;
    /** Liczba prób wykonanych wcześniej (przy ponowieniach). */
    attemptsSoFar?: number;
  },
  options: DeliverOptions,
): Promise<DeliveryResult> {
  const log = options.log ?? logger;
  const app = getAppConfig();
  const meta = getMetaConfig();
  const send = options.sendImpl ?? sendLeadEvent;

  const attemptsSoFar = params.attemptsSoFar ?? 0;
  const event = params.body.data[0];

  // Meta odrzuca zdarzenia starsze niż 7 dni — nie ma po co próbować.
  if (event && isEventTooOld(event.event_time)) {
    const attempts = attemptsSoFar;
    await updateLeadEventResult(params.eventId, { status: "dead", attempts });
    await upsertDeadLetter({
      eventId: params.eventId,
      messageId: params.messageId,
      payload: params.body as unknown as Record<string, unknown>,
      reason: "event_too_old",
      attempts,
    });

    log.error("deliver.event_too_old", { eventId: params.eventId, eventTime: event.event_time });
    return { outcome: "dead", eventId: params.eventId, attempts, reason: "event_too_old" };
  }

  const result: SendResult = await send(params.body, { budget: options.budget, log });
  const attempts = attemptsSoFar + result.attempts;
  const testMode = meta.META_TEST_MODE;

  if (result.outcome === "sent") {
    await updateLeadEventResult(params.eventId, {
      status: "sent",
      attempts,
      metaResponseCode: result.status,
      metaResponseBody: result.body,
      metaFbtraceId: result.fbtraceId,
      eventsReceived: result.eventsReceived,
      testMode,
    });
    await resolveDeadLetter(params.eventId, "Wysłane ponownie — Meta przyjęła zdarzenie.");

    return { outcome: "sent", eventId: params.eventId, attempts, status: result.status };
  }

  if (result.outcome === "permanent_failure") {
    await updateLeadEventResult(params.eventId, {
      status: "dead",
      attempts,
      metaResponseCode: result.status,
      metaResponseBody: result.body,
      metaFbtraceId: result.fbtraceId,
      testMode,
    });
    await upsertDeadLetter({
      eventId: params.eventId,
      messageId: params.messageId,
      payload: params.body as unknown as Record<string, unknown>,
      errorCode: result.status,
      errorBody: result.body,
      reason: "meta_4xx",
      attempts,
    });

    return {
      outcome: "dead",
      eventId: params.eventId,
      attempts,
      status: result.status,
      reason: "meta_4xx",
    };
  }

  if (result.outcome === "budget_exhausted") {
    await updateLeadEventResult(params.eventId, {
      status: "pending",
      attempts,
      metaResponseCode: result.status,
      metaResponseBody: result.body,
      testMode,
    });

    log.warn("deliver.pending", {
      eventId: params.eventId,
      attempts,
      reason: "function_time_budget",
    });
    return {
      outcome: "pending",
      eventId: params.eventId,
      attempts,
      status: result.status,
      reason: "budget_exhausted",
    };
  }

  // retryable_failure — decydujemy, czy jeszcze warto próbować.
  const exhausted = attempts >= app.PENDING_MAX_ATTEMPTS;

  await updateLeadEventResult(params.eventId, {
    status: exhausted ? "dead" : "failed_retryable",
    attempts,
    metaResponseCode: result.status,
    metaResponseBody: result.body ?? result.error,
    testMode,
  });

  if (exhausted) {
    await upsertDeadLetter({
      eventId: params.eventId,
      messageId: params.messageId,
      payload: params.body as unknown as Record<string, unknown>,
      errorCode: result.status,
      errorBody: result.body ?? result.error,
      reason: "max_attempts_exceeded",
      attempts,
    });

    log.error("deliver.max_attempts_exceeded", { eventId: params.eventId, attempts });
    return {
      outcome: "dead",
      eventId: params.eventId,
      attempts,
      status: result.status,
      reason: "max_attempts_exceeded",
    };
  }

  return {
    outcome: "retry_scheduled",
    eventId: params.eventId,
    attempts,
    status: result.status,
    reason: result.error ?? "meta_5xx",
  };
}

/** Wyciąga zapisany payload i sprawdza, czy nadaje się do ponownej wysyłki. */
export function payloadFromSnapshot(row: LeadEventRow): MetaEventsRequestBody | undefined {
  const snapshot = row.payloadSnapshot;
  if (!snapshot || typeof snapshot !== "object") return undefined;

  const data = (snapshot as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;

  return snapshot as unknown as MetaEventsRequestBody;
}

/**
 * Ponawia wysyłkę zapisanego zdarzenia.
 *
 * Payload pochodzi z `payload_snapshot`, więc `event_id` i `event_time`
 * zostają takie same — Meta rozpozna ewentualny duplikat i go odrzuci.
 * To dlatego ponowna wysyłka jest bezpieczna nawet wtedy, gdy poprzednia
 * próba faktycznie doszła, a my nie zdążyliśmy zapisać wyniku.
 */
export async function retryLeadEvent(
  eventId: string,
  options: DeliverOptions,
): Promise<DeliveryResult | { outcome: "not_found" | "already_sent" | "no_payload"; eventId: string }> {
  const row = await getLeadEvent(eventId);
  if (!row) return { outcome: "not_found", eventId };
  if (row.status === "sent") return { outcome: "already_sent", eventId };

  const body = payloadFromSnapshot(row);
  if (!body) return { outcome: "no_payload", eventId };

  return deliverEvent(
    { eventId, messageId: row.messageId, body, attemptsSoFar: row.attempts },
    options,
  );
}

export interface DrainResult {
  considered: number;
  delivered: number;
  pending: number;
  retryScheduled: number;
  dead: number;
  skippedNoPayload: number;
}

/**
 * Dokańcza zaległości: zdarzenia `pending` (którym zabrakło czasu w webhooku)
 * oraz `failed_retryable` (błąd przejściowy po stronie Meta).
 */
export async function drainPendingEvents(options: DeliverOptions & { limit?: number }): Promise<DrainResult> {
  const log = options.log ?? logger;
  const limit = options.limit ?? getAppConfig().PENDING_DRAIN_LIMIT;

  const rows = await listRetryableEvents(limit);
  const summary: DrainResult = {
    considered: rows.length,
    delivered: 0,
    pending: 0,
    retryScheduled: 0,
    dead: 0,
    skippedNoPayload: 0,
  };

  for (const row of rows) {
    if (!options.budget.hasAtLeast(3_000)) {
      log.warn("drain.budget_exhausted", { processed: summary.delivered, remaining: rows.length });
      break;
    }

    const body = payloadFromSnapshot(row);
    if (!body) {
      summary.skippedNoPayload += 1;
      await updateLeadEventResult(row.eventId, { status: "dead", attempts: row.attempts });
      await upsertDeadLetter({
        eventId: row.eventId,
        messageId: row.messageId,
        reason: "missing_payload_snapshot",
        attempts: row.attempts,
      });
      continue;
    }

    const result = await deliverEvent(
      {
        eventId: row.eventId,
        messageId: row.messageId,
        body,
        attemptsSoFar: row.attempts,
      },
      options,
    );

    if (result.outcome === "sent") summary.delivered += 1;
    else if (result.outcome === "pending") summary.pending += 1;
    else if (result.outcome === "retry_scheduled") summary.retryScheduled += 1;
    else summary.dead += 1;
  }

  return summary;
}
