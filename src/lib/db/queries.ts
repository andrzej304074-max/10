import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { getAppConfig } from "@/lib/config/env";

import { getDb } from "./client";
import {
  deadLetters,
  leadEvents,
  processedEmails,
  type DeadLetterRow,
  type EmailSource,
  type EmailStatus,
  type LeadEventRow,
  type LeadEventStatus,
  type NewLeadEvent,
  type ProcessedEmailRow,
} from "./schema";

/* ---------------------------------------------------------- e-maile ------- */

export interface ClaimEmailInput {
  messageId: string;
  source: EmailSource;
  provider?: string;
  fromMasked?: string;
  subject?: string;
  receivedAt?: Date;
}

export interface ClaimEmailResult {
  claimed: boolean;
  row?: ProcessedEmailRow;
}

/**
 * Po tylu milisekundach zajęcie w stanie `received` uznajemy za porzucone.
 *
 * Wiersz zostaje w tym stanie tylko wtedy, gdy funkcja padła między zajęciem
 * wiadomości a zapisem wyniku. Próg jest wyraźnie dłuższy niż `maxDuration`
 * (60 s), więc nie odbierze zajęcia funkcji, która wciąż pracuje.
 */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * „Zajmuje” wiadomość do przetworzenia.
 *
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` jest atomowy: jeśli dwie
 * instancje funkcji (webhook i cron) dostaną ten sam mail w tej samej chwili,
 * dokładnie jedna dostanie wiersz w odpowiedzi, a druga pustą tablicę.
 * To jest cały mechanizm blokady — nie potrzeba ani transakcji, ani Redisa.
 *
 * `setWhere` sprawia, że aktualizacja (czyli ponowne zajęcie) zachodzi wyłącznie
 * dla porzuconych zajęć. Wiadomość już rozstrzygnięta — `processed`, `skipped`
 * albo `parse_failed` — nigdy nie zostaje zajęta drugi raz, i to jest właśnie
 * gwarancja „ten sam mail nie generuje dwóch zdarzeń”.
 */
export async function claimEmail(input: ClaimEmailInput): Promise<ClaimEmailResult> {
  const db = getDb();
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  const claimed = await db
    .insert(processedEmails)
    .values({
      messageId: input.messageId,
      source: input.source,
      provider: input.provider,
      fromMasked: input.fromMasked,
      subject: input.subject,
      receivedAt: input.receivedAt,
      status: "received",
    })
    .onConflictDoUpdate({
      target: processedEmails.messageId,
      set: {
        source: input.source,
        provider: input.provider,
        status: "received",
        updatedAt: new Date(),
      },
      setWhere: and(
        eq(processedEmails.status, "received"),
        lt(processedEmails.updatedAt, staleBefore),
      ),
    })
    .returning();

  const row = claimed[0];
  if (row) return { claimed: true, row };

  const existing = await db
    .select()
    .from(processedEmails)
    .where(eq(processedEmails.messageId, input.messageId))
    .limit(1);

  return { claimed: false, row: existing[0] };
}

export async function markEmail(
  messageId: string,
  patch: { status: EmailStatus; skipReason?: string; listingId?: string },
): Promise<void> {
  const db = getDb();
  await db
    .update(processedEmails)
    .set({
      status: patch.status,
      skipReason: patch.skipReason,
      listingId: patch.listingId,
      processedAt: new Date(),
    })
    .where(eq(processedEmails.messageId, messageId));
}

/**
 * Message-ID już rozstrzygnięte — cron nie musi ich w ogóle pobierać z IMAP.
 *
 * Porzucone zajęcia (`received` starsze niż `STALE_CLAIM_MS`) celowo NIE trafiają
 * do wyniku: chcemy, żeby cron pobrał taką wiadomość ponownie i dokończył pracę,
 * której nie dokończył webhook.
 */
export async function filterKnownMessageIds(messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();

  const db = getDb();
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  const rows = await db
    .select({ messageId: processedEmails.messageId })
    .from(processedEmails)
    .where(
      and(
        inArray(processedEmails.messageId, messageIds),
        or(
          ne(processedEmails.status, "received"),
          gte(processedEmails.updatedAt, staleBefore),
        ),
      ),
    );

  return new Set(rows.map((row) => row.messageId));
}

/* ------------------------------------------------------------ zdarzenia --- */

export interface InsertLeadEventResult {
  created: boolean;
  row?: LeadEventRow;
}

/**
 * Tworzy zdarzenie. Konflikt na `event_id` albo `message_id` oznacza, że
 * zdarzenie już istnieje — wtedy nic nie wysyłamy.
 */
export async function insertLeadEvent(values: NewLeadEvent): Promise<InsertLeadEventResult> {
  const db = getDb();

  const inserted = await db.insert(leadEvents).values(values).onConflictDoNothing().returning();

  const row = inserted[0];
  if (row) return { created: true, row };

  const existing = await db
    .select()
    .from(leadEvents)
    .where(or(eq(leadEvents.eventId, values.eventId), eq(leadEvents.messageId, values.messageId)))
    .limit(1);

  return { created: false, row: existing[0] };
}

export interface LeadEventResultPatch {
  status: LeadEventStatus;
  attempts: number;
  metaResponseCode?: number;
  metaResponseBody?: string;
  metaFbtraceId?: string;
  eventsReceived?: number;
  testMode?: boolean;
}

export async function updateLeadEventResult(
  eventId: string,
  patch: LeadEventResultPatch,
): Promise<void> {
  const db = getDb();
  await db
    .update(leadEvents)
    .set({
      status: patch.status,
      attempts: patch.attempts,
      lastAttemptAt: new Date(),
      metaResponseCode: patch.metaResponseCode,
      metaResponseBody: patch.metaResponseBody,
      metaFbtraceId: patch.metaFbtraceId,
      eventsReceived: patch.eventsReceived,
      ...(patch.testMode === undefined ? {} : { testMode: patch.testMode }),
    })
    .where(eq(leadEvents.eventId, eventId));
}

export async function getLeadEvent(eventId: string): Promise<LeadEventRow | undefined> {
  const db = getDb();
  const rows = await db.select().from(leadEvents).where(eq(leadEvents.eventId, eventId)).limit(1);
  return rows[0];
}

/**
 * Zdarzenia do dokończenia przez cron: te, którym zabrakło czasu funkcji
 * (`pending`) oraz te, które poległy na błędzie przejściowym.
 *
 * Warunek na `last_attempt_at` daje odstęp między podejściami — bez niego cron
 * co 5 minut waliłby w Meta tym samym zdarzeniem bez opamiętania.
 */
export async function listRetryableEvents(limit: number): Promise<LeadEventRow[]> {
  const db = getDb();
  const { PENDING_RETRY_DELAY_SECONDS, PENDING_MAX_ATTEMPTS } = getAppConfig();
  const notBefore = new Date(Date.now() - PENDING_RETRY_DELAY_SECONDS * 1000);

  return db
    .select()
    .from(leadEvents)
    .where(
      and(
        inArray(leadEvents.status, ["pending", "failed_retryable"]),
        lt(leadEvents.attempts, PENDING_MAX_ATTEMPTS),
        or(isNull(leadEvents.lastAttemptAt), lt(leadEvents.lastAttemptAt, notBefore)),
      ),
    )
    .orderBy(leadEvents.createdAt)
    .limit(limit);
}

export async function listRecentLeadEvents(limit = 100): Promise<LeadEventRow[]> {
  const db = getDb();
  return db.select().from(leadEvents).orderBy(desc(leadEvents.createdAt)).limit(limit);
}

/* ---------------------------------------------------------- dead-letter --- */

export interface DeadLetterInput {
  eventId: string;
  messageId?: string;
  payload?: Record<string, unknown>;
  errorCode?: number;
  errorBody?: string;
  reason: string;
  attempts: number;
}

/**
 * Zapisuje (albo aktualizuje) wpis w dead-letter. Upsert, bo to samo zdarzenie
 * może trafić tu ponownie po nieudanej ponownej wysyłce z panelu.
 */
export async function upsertDeadLetter(input: DeadLetterInput): Promise<void> {
  const db = getDb();
  await db
    .insert(deadLetters)
    .values({
      eventId: input.eventId,
      messageId: input.messageId,
      payload: input.payload,
      errorCode: input.errorCode,
      errorBody: input.errorBody,
      reason: input.reason,
      attempts: input.attempts,
    })
    .onConflictDoUpdate({
      target: deadLetters.eventId,
      set: {
        errorCode: input.errorCode,
        errorBody: input.errorBody,
        reason: input.reason,
        attempts: input.attempts,
        resolvedAt: null,
        resolvedNote: null,
        updatedAt: new Date(),
      },
    });
}

export async function resolveDeadLetter(eventId: string, note: string): Promise<void> {
  const db = getDb();
  await db
    .update(deadLetters)
    .set({ resolvedAt: new Date(), resolvedNote: note })
    .where(eq(deadLetters.eventId, eventId));
}

export async function listOpenDeadLetters(limit = 50): Promise<DeadLetterRow[]> {
  const db = getDb();
  return db
    .select()
    .from(deadLetters)
    .where(isNull(deadLetters.resolvedAt))
    .orderBy(desc(deadLetters.createdAt))
    .limit(limit);
}

/* --------------------------------------------------------------- health --- */

export interface HealthSummary {
  windowHours: number;
  emails: Record<string, number>;
  events: Record<string, number>;
  openDeadLetters: number;
  lastEventAt: string | null;
}

export async function pingDatabase(): Promise<void> {
  const db = getDb();
  await db.execute(sql`select 1`);
}

export async function getHealthSummary(windowHours = 24): Promise<HealthSummary> {
  const db = getDb();
  const since = new Date(Date.now() - windowHours * 3600 * 1000);

  const [emailRows, eventRows, deadRows, lastEventRows] = await Promise.all([
    db
      .select({ status: processedEmails.status, count: sql<number>`count(*)::int` })
      .from(processedEmails)
      .where(gte(processedEmails.createdAt, since))
      .groupBy(processedEmails.status),
    db
      .select({ status: leadEvents.status, count: sql<number>`count(*)::int` })
      .from(leadEvents)
      .where(gte(leadEvents.createdAt, since))
      .groupBy(leadEvents.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(deadLetters)
      .where(isNull(deadLetters.resolvedAt)),
    db
      .select({ createdAt: leadEvents.createdAt })
      .from(leadEvents)
      .orderBy(desc(leadEvents.createdAt))
      .limit(1),
  ]);

  const toRecord = (rows: Array<{ status: string; count: number }>): Record<string, number> =>
    Object.fromEntries(rows.map((row) => [row.status, row.count]));

  return {
    windowHours,
    emails: toRecord(emailRows),
    events: toRecord(eventRows),
    openDeadLetters: deadRows[0]?.count ?? 0,
    lastEventAt: lastEventRows[0]?.createdAt.toISOString() ?? null,
  };
}
