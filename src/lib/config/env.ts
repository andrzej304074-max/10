import { z } from "zod";

/**
 * Walidacja konfiguracji przez zod.
 *
 * Zmienne są podzielone na grupy według ścieżki, która ich potrzebuje:
 *
 *  - `meta`      — wymagana wszędzie tam, gdzie wysyłamy zdarzenie,
 *  - `db`        — wymagana wszędzie tam, gdzie zapisujemy stan,
 *  - `inbound`   — tylko dla POST /api/inbound/email,
 *  - `cron`      — tylko dla GET /api/cron/poll-imap i POST /api/dev/send-test-lead,
 *  - `imap`      — tylko dla ścieżki zapasowej (cron),
 *  - `dashboard` — tylko dla /dashboard,
 *  - `app`       — strojenie bez sekretów, wszystko z wartościami domyślnymi.
 *
 * Walidacja jest leniwa i zapamiętywana (memoizowana). Dzięki temu `next build`
 * nie wywraca się na braku sekretów, a jednocześnie pierwsze wywołanie danej
 * ścieżki w runtime kończy się czytelnym błędem zamiast `undefined` w URL-u.
 */

export class ConfigError extends Error {
  constructor(
    readonly group: string,
    readonly issues: string[],
  ) {
    super(
      `Błąd konfiguracji (${group}):\n` +
        issues.map((issue) => `  • ${issue}`).join("\n") +
        `\n\nUzupełnij zmienne środowiskowe w panelu Vercel ` +
        `(Project → Settings → Environment Variables) albo w pliku .env.local. ` +
        `Wzór: .env.example`,
    );
    this.name = "ConfigError";
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `${path}: ${issue.message}`;
  });
}

function parseGroup<T extends z.ZodTypeAny>(group: string, schema: T, source: unknown): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(group, formatIssues(result.error));
  }
  return result.data;
}

/** Pusty string traktujemy jak brak zmiennej — Vercel potrafi zwrócić "". */
const optionalString = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

const requiredString = (message: string) =>
  z
    .string({ required_error: message, invalid_type_error: message })
    .transform((value) => value.trim())
    .pipe(z.string().min(1, message));

const booleanFlag = (defaultValue: boolean) =>
  optionalString.transform((value) => {
    if (value === undefined) return defaultValue;
    return ["1", "true", "yes", "on", "tak"].includes(value.toLowerCase());
  });

const intInRange = (defaultValue: number, min: number, max: number) =>
  optionalString.transform((value, ctx) => {
    if (value === undefined) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `oczekiwano liczby całkowitej z zakresu ${min}–${max}, otrzymano "${value}"`,
      });
      return z.NEVER;
    }
    return parsed;
  });

function memoize<T>(factory: () => T): () => T {
  let cached: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      cached = factory();
      done = true;
    }
    return cached as T;
  };
}

/* ------------------------------------------------------------------ META -- */

const metaSchema = z
  .object({
    META_ACCESS_TOKEN: requiredString(
      "brak tokenu dostępu do Meta. Wygeneruj token systemowy z uprawnieniem " +
        "ads_management w Business Managerze (patrz README, sekcja „Token systemowy”).",
    ),
    META_DATASET_ID: requiredString("brak identyfikatora zestawu danych / pixela Meta.").pipe(
      z.string().regex(/^\d{5,}$/, "identyfikator zestawu danych to same cyfry (min. 5 znaków)."),
    ),
    META_API_VERSION: optionalString.transform((value) => value ?? "v21.0"),
    META_TEST_EVENT_CODE: optionalString,
    META_TEST_MODE: booleanFlag(false),
  })
  .superRefine((value, ctx) => {
    if (!/^v\d+\.\d+$/.test(value.META_API_VERSION)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["META_API_VERSION"],
        message: `oczekiwano formatu "vXX.Y" (np. v21.0), otrzymano "${value.META_API_VERSION}".`,
      });
    }
    if (value.META_TEST_MODE && !value.META_TEST_EVENT_CODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["META_TEST_EVENT_CODE"],
        message:
          "META_TEST_MODE jest włączony, więc META_TEST_EVENT_CODE jest wymagany. " +
          'Kod znajdziesz w Menedżerze zdarzeń → zakładka „Testowanie zdarzeń” (format: TEST12345).',
      });
    }
  });

export type MetaConfig = z.infer<typeof metaSchema>;

export const getMetaConfig = memoize((): MetaConfig => parseGroup("Meta", metaSchema, process.env));

/* -------------------------------------------------------------------- DB -- */

const dbSchema = z.object({
  POSTGRES_URL: requiredString(
    "brak connection stringa do bazy. Podłącz Vercel Postgres (Neon) w zakładce Storage — " +
      "zmienna POSTGRES_URL zostanie dodana automatycznie.",
  ).pipe(
    z
      .string()
      .regex(/^postgres(ql)?:\/\//i, 'connection string musi zaczynać się od "postgres://".'),
  ),
});

export type DbConfig = z.infer<typeof dbSchema>;

export const getDbConfig = memoize((): DbConfig => parseGroup("Baza danych", dbSchema, process.env));

/* --------------------------------------------------------------- INBOUND -- */

export const INBOUND_PROVIDERS = ["resend", "mailgun"] as const;
export type InboundProvider = (typeof INBOUND_PROVIDERS)[number];

const inboundSchema = z.object({
  INBOUND_PROVIDER: optionalString
    .transform((value) => (value ?? "resend").toLowerCase())
    .pipe(
      z.enum(INBOUND_PROVIDERS, {
        errorMap: () => ({ message: `dozwolone wartości: ${INBOUND_PROVIDERS.join(", ")}.` }),
      }),
    ),
  INBOUND_WEBHOOK_SECRET: requiredString(
    "brak sekretu webhooka. Dla Resend to Signing Secret (zaczyna się od „whsec_”), " +
      "dla Mailguna — HTTP webhook signing key z ustawień domeny.",
  ),
  /** Tolerancja zegara przy weryfikacji podpisu (ochrona przed replay). */
  INBOUND_SIGNATURE_TOLERANCE_SECONDS: intInRange(300, 30, 3600),
});

export type InboundConfig = z.infer<typeof inboundSchema>;

export const getInboundConfig = memoize(
  (): InboundConfig => parseGroup("Webhook poczty przychodzącej", inboundSchema, process.env),
);

/* ------------------------------------------------------------------ CRON -- */

const cronSchema = z.object({
  CRON_SECRET: requiredString(
    "brak CRON_SECRET. Wygeneruj losowy ciąg (np. `openssl rand -hex 32`) i dodaj go " +
      "jako zmienną środowiskową — Vercel Cron automatycznie wyśle go w nagłówku Authorization.",
  ).pipe(z.string().min(16, "CRON_SECRET powinien mieć co najmniej 16 znaków.")),
});

export type CronConfig = z.infer<typeof cronSchema>;

export const getCronConfig = memoize((): CronConfig => parseGroup("Cron", cronSchema, process.env));

/* ------------------------------------------------------------------ IMAP -- */

const imapSchema = z.object({
  IMAP_HOST: requiredString("brak hosta IMAP (np. imap.gmail.com)."),
  IMAP_PORT: intInRange(993, 1, 65535),
  IMAP_USER: requiredString("brak loginu IMAP (zwykle pełny adres e-mail)."),
  IMAP_PASSWORD: requiredString(
    "brak hasła IMAP. Dla Gmaila użyj hasła aplikacji, nie hasła do konta.",
  ),
  IMAP_SECURE: booleanFlag(true),
  IMAP_MAILBOX: optionalString.transform((value) => value ?? "INBOX"),
  /** Ile maili maksymalnie przetworzyć w jednym przebiegu crona. */
  IMAP_MAX_MESSAGES_PER_RUN: intInRange(25, 1, 200),
  /** Jak daleko wstecz sięgać przy wyszukiwaniu wiadomości. */
  IMAP_LOOKBACK_HOURS: intInRange(24, 1, 168),
});

export type ImapConfig = z.infer<typeof imapSchema>;

export const getImapConfig = memoize((): ImapConfig => parseGroup("IMAP", imapSchema, process.env));

/* ------------------------------------------------------------- DASHBOARD -- */

const dashboardSchema = z.object({
  DASHBOARD_PASSWORD: requiredString("brak hasła do panelu /dashboard.").pipe(
    z.string().min(12, "hasło do panelu powinno mieć co najmniej 12 znaków."),
  ),
  /** Jak długo ważna jest sesja panelu. */
  DASHBOARD_SESSION_HOURS: intInRange(12, 1, 720),
});

export type DashboardConfig = z.infer<typeof dashboardSchema>;

export const getDashboardConfig = memoize(
  (): DashboardConfig => parseGroup("Panel", dashboardSchema, process.env),
);

/* ------------------------------------------------------------------- APP -- */

/** Strojenie aplikacji. Same wartości domyślne, żadnych sekretów. */
const appSchema = z.object({
  /** Używany, gdy w mailu nie ma linku do ogłoszenia. */
  DEFAULT_EVENT_SOURCE_URL: optionalString
    .transform((value) => value ?? "https://www.otodom.pl/")
    .pipe(z.string().url("oczekiwano poprawnego URL-a (z https://).")),
  DEFAULT_LISTING_ID: optionalString.transform((value) => value ?? "unknown"),
  DEFAULT_CONTENT_NAME: optionalString.transform(
    (value) => value ?? "Hala produkcyjno-magazynowa Kraków",
  ),
  /** Domyślny kraj przy normalizacji telefonu (kod ISO 3166-1 alpha-2). */
  PHONE_DEFAULT_COUNTRY: optionalString
    .transform((value) => (value ?? "PL").toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, "oczekiwano dwuliterowego kodu kraju, np. PL.")),
  /** Okno zaokrąglenia timestampu w event_id (sekundy). */
  EVENT_ID_BUCKET_SECONDS: intInRange(300, 1, 86_400),
  META_MAX_ATTEMPTS: intInRange(5, 1, 10),
  META_TIMEOUT_MS: intInRange(10_000, 1_000, 60_000),
  META_RETRY_BASE_MS: intInRange(500, 50, 10_000),
  META_RETRY_MAX_DELAY_MS: intInRange(8_000, 100, 60_000),
  /** Ile zaległych zdarzeń cron próbuje dokończyć w jednym przebiegu. */
  PENDING_DRAIN_LIMIT: intInRange(20, 1, 200),
  /** Minimalny odstęp między kolejnymi podejściami crona do tego samego zdarzenia. */
  PENDING_RETRY_DELAY_SECONDS: intInRange(120, 10, 86_400),
  /** Po tylu nieudanych próbach zdarzenie ląduje w dead-letter na stałe. */
  PENDING_MAX_ATTEMPTS: intInRange(15, 1, 100),
});

export type AppConfig = z.infer<typeof appSchema>;

export const getAppConfig = memoize((): AppConfig => parseGroup("Aplikacja", appSchema, process.env));

/* ------------------------------------------------------------ DIAGNOSTYKA -- */

export interface ConfigGroupStatus {
  group: string;
  ok: boolean;
  /** Komunikat błędu — nigdy nie zawiera wartości zmiennych, tylko ich nazwy. */
  error?: string;
}

/**
 * Sprawdza, które grupy konfiguracji są kompletne. Używane przez /api/health.
 * Zwraca wyłącznie nazwy zmiennych i komunikaty — nigdy wartości.
 */
export function describeConfig(): ConfigGroupStatus[] {
  const groups: Array<[string, () => unknown]> = [
    ["meta", getMetaConfig],
    ["db", getDbConfig],
    ["inbound", getInboundConfig],
    ["cron", getCronConfig],
    ["imap", getImapConfig],
    ["dashboard", getDashboardConfig],
    ["app", getAppConfig],
  ];

  return groups.map(([group, load]) => {
    try {
      load();
      return { group, ok: true };
    } catch (error) {
      return {
        group,
        ok: false,
        error: error instanceof Error ? error.message : "nieznany błąd konfiguracji",
      };
    }
  });
}
