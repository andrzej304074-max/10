import { getAppConfig } from "@/lib/config/env";
import { claimEmail, insertLeadEvent, markEmail } from "@/lib/db/queries";
import { hasUsableIdentifier, hashIdentity } from "@/lib/hashing/hash";
import { maskHash, maskSender, truncate } from "@/lib/hashing/mask";
import { shouldProcessEmail } from "@/lib/mail/filter";
import type { NormalizedInboundEmail } from "@/lib/mail/types";
import { buildLeadEvent, buildRequestBody, type BuildLeadEventOptions } from "@/lib/meta/event";
import type { MetaEventsRequestBody } from "@/lib/meta/types";
import { logger, type Logger } from "@/lib/logger";
import { parseOtodomLead } from "@/lib/parser/otodom";
import type { TimeBudget } from "@/lib/time-budget";

import { deliverEvent, type DeliveryOutcome } from "./deliver";

export type ProcessOutcome =
  /** Ten mail był już przetwarzany (unikalny indeks na message_id). */
  | "duplicate_email"
  /** Odrzucony przez filtr nadawcy/tematu — nie jest to błąd. */
  | "skipped"
  /** Pasował do filtrów, ale brak e-maila i telefonu — nie ma czego wysłać. */
  | "parse_failed"
  /** Zdarzenie o tym `event_id` już istnieje. */
  | "duplicate_event"
  /** Tryb dry-run — payload zbudowany, nic nie wysłano i nic nie zapisano. */
  | "dry_run"
  | DeliveryOutcome;

export interface ProcessResult {
  outcome: ProcessOutcome;
  messageId: string;
  eventId?: string;
  reason?: string;
  status?: number;
  attempts?: number;
  /** Zwracany wyłącznie w trybie dry-run. */
  payload?: MetaEventsRequestBody;
}

export interface ProcessOptions {
  budget: TimeBudget;
  /** Buduje payload i zwraca go, bez wysyłki i bez zapisu do bazy. */
  dryRun?: boolean;
  log?: Logger;
  /** Nadpisania przy budowie zdarzenia — używane wyłącznie przez endpoint testowy. */
  eventOptions?: BuildLeadEventOptions;
  /** Wstrzykiwane w testach. */
  deliverImpl?: typeof deliverEvent;
}

/**
 * Wspólny rdzeń obu ścieżek (webhook i cron).
 *
 * Kolejność kroków jest istotna:
 *  1. ZAJĘCIE wiadomości (`INSERT ... ON CONFLICT DO NOTHING`) — zanim cokolwiek
 *     zrobimy, bo to jedyny moment, w którym wyścig webhooka z cronem może się
 *     rozstrzygnąć atomowo. Odrzucone maile też trafiają do tabeli: dzięki temu
 *     ten sam śmieć nie jest filtrowany po raz drugi przy każdym przebiegu crona.
 *  2. FILTR nadawcy i tematu.
 *  3. PARSOWANIE i haszowanie.
 *  4. UTWORZENIE zdarzenia (`ON CONFLICT DO NOTHING` na `event_id`).
 *  5. WYSYŁKA z retry i budżetem czasu.
 */
export async function processInboundEmail(
  email: NormalizedInboundEmail,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const log = (options.log ?? logger).child({ messageId: email.messageId });
  const app = getAppConfig();
  const deliver = options.deliverImpl ?? deliverEvent;

  /* --- 1. zajęcie wiadomości ------------------------------------------------ */
  if (!options.dryRun) {
    const claim = await claimEmail({
      messageId: email.messageId,
      source: email.source,
      provider: email.provider,
      fromMasked: maskSender(email.from),
      subject: truncate(email.subject, 300),
      receivedAt: email.date,
    });

    if (!claim.claimed) {
      log.info("pipeline.duplicate_email", { previousStatus: claim.row?.status });
      return { outcome: "duplicate_email", messageId: email.messageId };
    }
  }

  /* --- 2. filtr ------------------------------------------------------------- */
  const filter = shouldProcessEmail(email);
  if (!filter.ok) {
    log.info("pipeline.skipped", {
      reason: filter.reason,
      signals: filter.signals,
      from: maskSender(email.from),
    });
    if (!options.dryRun) {
      await markEmail(email.messageId, { status: "skipped", skipReason: filter.reason });
    }
    return { outcome: "skipped", messageId: email.messageId, reason: filter.reason };
  }

  /* --- 3. parsowanie i haszowanie ------------------------------------------- */
  const lead = parseOtodomLead(
    { text: email.text, html: email.html, subject: email.subject, date: email.date },
    { defaultCountry: app.PHONE_DEFAULT_COUNTRY, log },
  );

  const hashes = hashIdentity(
    {
      email: lead.email,
      phone: lead.phone,
      firstName: lead.firstName,
      lastName: lead.lastName,
      country: app.PHONE_DEFAULT_COUNTRY,
    },
    { phoneCountry: app.PHONE_DEFAULT_COUNTRY },
  );

  if (!hasUsableIdentifier(hashes)) {
    // Meta wymaga co najmniej jednego identyfikatora — bez e-maila i telefonu
    // zdarzenie i tak zostałoby odrzucone.
    log.warn("pipeline.parse_failed", {
      reason: "no_identifier",
      missingFields: lead.missingFields,
    });
    if (!options.dryRun) {
      await markEmail(email.messageId, {
        status: "parse_failed",
        skipReason: "no_identifier",
        listingId: lead.listingId,
      });
    }
    return { outcome: "parse_failed", messageId: email.messageId, reason: "no_identifier" };
  }

  /* --- 4. budowa zdarzenia --------------------------------------------------- */
  const event = buildLeadEvent(
    {
      hashes,
      sentAt: lead.sentAt,
      messageId: email.messageId,
      listingId: lead.listingId,
      listingUrl: lead.listingUrl,
      listingTitle: lead.listingTitle,
    },
    options.eventOptions,
  );

  const body = buildRequestBody(event);

  log.info("pipeline.event_built", {
    eventId: event.event_id,
    listingId: event.custom_data.listing_id,
    // W logu wyłącznie zamaskowane skróty hashy — nigdy dane osobowe.
    identifiers: {
      em: maskHash(hashes.emHash),
      ph: maskHash(hashes.phHash),
      fn: maskHash(hashes.fnHash),
      ln: maskHash(hashes.lnHash),
    },
    missingFields: lead.missingFields,
  });

  if (options.dryRun) {
    return {
      outcome: "dry_run",
      messageId: email.messageId,
      eventId: event.event_id,
      payload: body,
    };
  }

  const inserted = await insertLeadEvent({
    messageId: email.messageId,
    eventId: event.event_id,
    eventName: event.event_name,
    eventTime: new Date(event.event_time * 1000),
    listingId: event.custom_data.listing_id,
    eventSourceUrl: event.event_source_url,
    emHash: hashes.emHash,
    phHash: hashes.phHash,
    fnHash: hashes.fnHash,
    lnHash: hashes.lnHash,
    countryHash: hashes.countryHash,
    payloadSnapshot: body as unknown as Record<string, unknown>,
    status: "pending",
  });

  await markEmail(email.messageId, { status: "processed", listingId: lead.listingId });

  if (!inserted.created) {
    log.info("pipeline.duplicate_event", { eventId: event.event_id });
    return {
      outcome: "duplicate_event",
      messageId: email.messageId,
      eventId: event.event_id,
    };
  }

  /* --- 5. wysyłka ------------------------------------------------------------ */
  const delivery = await deliver(
    { eventId: event.event_id, messageId: email.messageId, body },
    { budget: options.budget, log },
  );

  return {
    outcome: delivery.outcome,
    messageId: email.messageId,
    eventId: delivery.eventId,
    status: delivery.status,
    attempts: delivery.attempts,
    reason: delivery.reason,
  };
}
