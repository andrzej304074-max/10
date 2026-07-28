import { getAppConfig } from "@/lib/config/env";
import { sha256Hex, toUserData, type IdentityHashes } from "@/lib/hashing/hash";

import type { MetaEventsRequestBody, MetaLeadEvent } from "./types";

export const EVENT_NAME = "Lead";
export const LEAD_SOURCE = "otodom";
export const ACTION_SOURCE = "system_generated" as const;

/** Meta odrzuca zdarzenia starsze niż 7 dni. */
export const MAX_EVENT_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface BuildLeadEventInput {
  hashes: IdentityHashes;
  /** Data wysłania maila — źródło `event_time`. */
  sentAt: Date;
  /** Używany jako składnik tożsamości, gdy brak e-maila i telefonu. */
  messageId: string;
  listingId?: string;
  listingUrl?: string;
  listingTitle?: string;
}

export interface BuildLeadEventOptions {
  defaultEventSourceUrl?: string;
  defaultListingId?: string;
  defaultContentName?: string;
  /** Okno zaokrąglenia timestampu w `event_id` (sekundy). */
  bucketSeconds?: number;
  eventName?: string;
}

/**
 * Deterministyczny `event_id`.
 *
 * SHA-256 z trzech składników: hasha tożsamości (e-mail, a gdy go brak —
 * telefon lub Message-ID), identyfikatora ogłoszenia i timestampu zaokrąglonego
 * w dół do pełnego okna (domyślnie 5 minut).
 *
 * Zaokrąglenie ma znaczenie praktyczne: jeśli ten sam mail dotrze dwiema
 * ścieżkami (webhook + IMAP) i nagłówki `Date` będą się różnić o kilkanaście
 * sekund, oba przebiegi wyliczą ten sam `event_id`, a Meta zdeduplikuje
 * zdarzenie po swojej stronie — nawet gdyby zawiodła nasza deduplikacja
 * po `message_id`.
 */
export function buildEventId(input: {
  identityHash: string;
  listingId: string;
  eventTimeSeconds: number;
  bucketSeconds?: number;
}): string {
  const bucketSeconds = input.bucketSeconds ?? getAppConfig().EVENT_ID_BUCKET_SECONDS;
  const bucket = Math.floor(input.eventTimeSeconds / bucketSeconds) * bucketSeconds;

  return sha256Hex(`${input.identityHash}|${input.listingId}|${bucket}`);
}

/** Tożsamość leada na potrzeby `event_id`: e-mail → telefon → Message-ID. */
export function resolveIdentityHash(hashes: IdentityHashes, messageId: string): string {
  return hashes.emHash ?? hashes.phHash ?? sha256Hex(messageId);
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function isEventTooOld(eventTimeSeconds: number, nowSeconds = toUnixSeconds(new Date())): boolean {
  return nowSeconds - eventTimeSeconds > MAX_EVENT_AGE_SECONDS;
}

/** Buduje kompletne zdarzenie Lead gotowe do wysłania. */
export function buildLeadEvent(
  input: BuildLeadEventInput,
  options: BuildLeadEventOptions = {},
): MetaLeadEvent {
  const app = getAppConfig();

  const eventSourceUrl =
    input.listingUrl ?? options.defaultEventSourceUrl ?? app.DEFAULT_EVENT_SOURCE_URL;
  const listingId = input.listingId ?? options.defaultListingId ?? app.DEFAULT_LISTING_ID;
  const contentName =
    input.listingTitle ?? options.defaultContentName ?? app.DEFAULT_CONTENT_NAME;

  const eventTime = toUnixSeconds(input.sentAt);

  const eventId = buildEventId({
    identityHash: resolveIdentityHash(input.hashes, input.messageId),
    listingId,
    eventTimeSeconds: eventTime,
    bucketSeconds: options.bucketSeconds ?? app.EVENT_ID_BUCKET_SECONDS,
  });

  return {
    event_name: options.eventName ?? EVENT_NAME,
    event_time: eventTime,
    event_id: eventId,
    action_source: ACTION_SOURCE,
    event_source_url: eventSourceUrl,
    user_data: toUserData(input.hashes),
    custom_data: {
      lead_source: LEAD_SOURCE,
      listing_id: listingId,
      content_name: contentName,
    },
  };
}

/**
 * Ciało żądania. Świadomie BEZ `access_token` — token dokleja klient tuż przed
 * wysyłką, dzięki czemu payload można bezpiecznie zwrócić w trybie dry-run
 * i zapisać w bazie jako `payload_snapshot`.
 */
export function buildRequestBody(
  event: MetaLeadEvent,
  options: { testEventCode?: string } = {},
): MetaEventsRequestBody {
  const body: MetaEventsRequestBody = { data: [event] };
  if (options.testEventCode) body.test_event_code = options.testEventCode;
  return body;
}
