import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Schemat bazy.
 *
 * ZASADA: w bazie nie ma ani jednego pola z danymi osobowymi w postaci jawnej.
 * Tożsamość leada reprezentują wyłącznie hashe SHA-256 (`*_hash`), a nadawca
 * wiadomości jest zamaskowany (`from_masked`, np. „j***@otodom.pl”).
 *
 * Idempotencję zapewniają dwa unikalne indeksy:
 *  - `processed_emails.message_id` — ten sam mail nie zostanie przetworzony dwa razy,
 *  - `lead_events.event_id`        — to samo zdarzenie nie poleci do Meta dwa razy.
 */

export const emailSourceEnum = pgEnum("email_source", ["webhook", "imap", "manual"]);

export const emailStatusEnum = pgEnum("email_status", [
  /** Wiadomość zajęta do przetworzenia (rekord powstał, praca trwa). */
  "received",
  /** Odrzucona przez filtr nadawcy/tematu — to nie jest błąd. */
  "skipped",
  /** Pasowała do filtrów, ale nie dało się wyciągnąć identyfikatora leada. */
  "parse_failed",
  /** Przetworzona, zdarzenie utworzone. */
  "processed",
]);

export const leadEventStatusEnum = pgEnum("lead_event_status", [
  /** Utworzone, jeszcze niewysłane (albo zabrakło czasu funkcji). */
  "pending",
  /** Przyjęte przez Meta. */
  "sent",
  /** Błąd przejściowy (5xx / timeout / 429) — cron spróbuje ponownie. */
  "failed_retryable",
  /** Błąd trwały (4xx) albo wyczerpane próby — leży w dead-letter. */
  "dead",
]);

/* ------------------------------------------------------- processed_emails -- */

export const processedEmails = pgTable(
  "processed_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Message-ID z nagłówków wiadomości — klucz idempotencji. */
    messageId: text("message_id").notNull(),
    source: emailSourceEnum("source").notNull(),
    /** resend | mailgun | imap | manual */
    provider: text("provider"),
    /** Nadawca w postaci zamaskowanej — NIGDY pełny adres. */
    fromMasked: text("from_masked"),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    status: emailStatusEnum("status").notNull().default("received"),
    /** Powód odrzucenia (kod, nie treść wiadomości). */
    skipReason: text("skip_reason"),
    listingId: text("listing_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("processed_emails_message_id_key").on(table.messageId),
    index("processed_emails_created_at_idx").on(table.createdAt),
    index("processed_emails_status_idx").on(table.status),
  ],
);

/* ------------------------------------------------------------ lead_events -- */

export const leadEvents = pgTable(
  "lead_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: text("message_id").notNull(),
    /** Deterministyczny identyfikator zdarzenia — deduplikacja po stronie Meta. */
    eventId: text("event_id").notNull(),
    eventName: text("event_name").notNull().default("Lead"),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    listingId: text("listing_id"),
    eventSourceUrl: text("event_source_url"),

    /* --- dane osobowe: WYŁĄCZNIE SHA-256 ---------------------------------- */
    emHash: text("em_hash"),
    phHash: text("ph_hash"),
    fnHash: text("fn_hash"),
    lnHash: text("ln_hash"),
    countryHash: text("country_hash"),

    /**
     * Gotowy payload wysłany do Meta (już po haszowaniu — bez danych jawnych).
     * Dzięki niemu ponowna wysyłka z panelu nie wymaga ponownego parsowania
     * maila i zachowuje oryginalne `event_id` oraz `event_time`.
     */
    payloadSnapshot: jsonb("payload_snapshot").$type<Record<string, unknown>>(),

    status: leadEventStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),

    /* --- odpowiedź Meta --------------------------------------------------- */
    metaResponseCode: integer("meta_response_code"),
    metaResponseBody: text("meta_response_body"),
    metaFbtraceId: text("meta_fbtrace_id"),
    eventsReceived: integer("events_received"),

    /** Czy zdarzenie poleciało z `test_event_code`. */
    testMode: boolean("test_mode").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("lead_events_event_id_key").on(table.eventId),
    uniqueIndex("lead_events_message_id_key").on(table.messageId),
    index("lead_events_status_idx").on(table.status, table.lastAttemptAt),
    index("lead_events_created_at_idx").on(table.createdAt),
  ],
);

/* ----------------------------------------------------------- dead_letters -- */

export const deadLetters = pgTable(
  "dead_letters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull(),
    messageId: text("message_id"),
    /** Payload gotowy do ponowienia — wyłącznie hashe. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    errorCode: integer("error_code"),
    errorBody: text("error_body"),
    /** Powód trafienia do dead-letter (kod, nie treść). */
    reason: text("reason"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedNote: text("resolved_note"),
  },
  (table) => [
    uniqueIndex("dead_letters_event_id_key").on(table.eventId),
    index("dead_letters_resolved_at_idx").on(table.resolvedAt),
    index("dead_letters_created_at_idx").on(table.createdAt),
  ],
);

export type ProcessedEmailRow = typeof processedEmails.$inferSelect;
export type NewProcessedEmail = typeof processedEmails.$inferInsert;
export type LeadEventRow = typeof leadEvents.$inferSelect;
export type NewLeadEvent = typeof leadEvents.$inferInsert;
export type DeadLetterRow = typeof deadLetters.$inferSelect;
export type NewDeadLetter = typeof deadLetters.$inferInsert;

export type LeadEventStatus = (typeof leadEventStatusEnum.enumValues)[number];
export type EmailStatus = (typeof emailStatusEnum.enumValues)[number];
export type EmailSource = (typeof emailSourceEnum.enumValues)[number];
