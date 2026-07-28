import { getAppConfig, getMetaConfig } from "@/lib/config/env";
import { truncate } from "@/lib/hashing/mask";
import { logger, redact, type Logger } from "@/lib/logger";
import { TimeBudget } from "@/lib/time-budget";

import type { MetaErrorResponse, MetaEventsRequestBody, MetaSuccessResponse } from "./types";

export type SendOutcome =
  /** Meta przyjęła zdarzenie. */
  | "sent"
  /** Błąd przejściowy — cron ponowi. */
  | "retryable_failure"
  /** Błąd trwały (4xx) — do dead-letter, bez ponawiania. */
  | "permanent_failure"
  /** Skończył się budżet czasu funkcji — zdarzenie zostaje `pending`. */
  | "budget_exhausted";

export interface SendResult {
  outcome: SendOutcome;
  attempts: number;
  status?: number;
  /** Treść odpowiedzi, przycięta i z wyciętymi sekretami. */
  body?: string;
  fbtraceId?: string;
  eventsReceived?: number;
  error?: string;
}

export interface SendEventOptions {
  budget: TimeBudget;
  testEventCode?: string;
  /** Wstrzykiwane w testach. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Wstrzykiwane w testach — usuwa losowość backoffu. */
  randomImpl?: () => number;
  log?: Logger;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function metaEndpoint(apiVersion: string, datasetId: string): string {
  return `https://graph.facebook.com/${apiVersion}/${datasetId}/events`;
}

/** Czy kod odpowiedzi kwalifikuje się do ponowienia. */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true; // rate limit — przeczekać i spróbować
  return status >= 500;
}

/**
 * Opóźnienie przed kolejną próbą: exponential backoff z pełnym jitterem.
 *
 * Jitter jest istotny, bo cron potrafi ruszyć z kilkoma zaległymi zdarzeniami
 * naraz — bez rozrzutu wszystkie uderzałyby w Meta w tej samej milisekundzie.
 */
export function backoffDelayMs(
  attempt: number,
  { baseMs, maxMs, random = Math.random }: { baseMs: number; maxMs: number; random?: () => number },
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return undefined;
}

/**
 * Wysyła zdarzenie do Meta Conversions API.
 *
 * Polityka ponawiania:
 *  - 2xx                         → `sent`,
 *  - 429 i 5xx oraz błędy sieci  → ponawiane (do META_MAX_ATTEMPTS),
 *  - pozostałe 4xx               → `permanent_failure`, bez ponawiania
 *                                  (zły token, zły payload — ponawianie nic nie da),
 *  - brak czasu w budżecie       → `budget_exhausted`, zdarzenie zostaje `pending`.
 *
 * Budżet czasu jest sprawdzany PRZED każdą próbą i przed każdym oczekiwaniem.
 * Dzięki temu funkcja nigdy nie zostaje ubita w trakcie żądania — zawsze
 * zostaje jej tyle czasu, żeby zapisać wynik do bazy.
 */
export async function sendLeadEvent(
  body: MetaEventsRequestBody,
  options: SendEventOptions,
): Promise<SendResult> {
  const meta = getMetaConfig();
  const app = getAppConfig();
  const log = options.log ?? logger;

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const random = options.randomImpl ?? Math.random;

  const url = metaEndpoint(meta.META_API_VERSION, meta.META_DATASET_ID);
  const testEventCode =
    options.testEventCode ?? (meta.META_TEST_MODE ? meta.META_TEST_EVENT_CODE : undefined);

  const payload = JSON.stringify({
    ...body,
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
    access_token: meta.META_ACCESS_TOKEN,
  });

  let attempts = 0;
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= app.META_MAX_ATTEMPTS; attempt += 1) {
    // Zostawiamy sobie margines na zapis wyniku do bazy.
    const remaining = options.budget.remainingMs();
    const timeoutMs = Math.min(app.META_TIMEOUT_MS, remaining - 500);

    if (timeoutMs < 1_000) {
      log.warn("meta.budget_exhausted", {
        attempt,
        remainingMs: remaining,
        eventId: body.data[0]?.event_id,
      });
      return {
        outcome: "budget_exhausted",
        attempts,
        status: lastStatus,
        body: lastBody,
        error: lastError,
      };
    }

    attempts = attempt;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const rawBody = await response.text();
      lastStatus = response.status;
      lastBody = truncate(redact(rawBody), 2_000);

      if (response.ok) {
        const parsed = safeJson<MetaSuccessResponse>(rawBody);
        log.info("meta.sent", {
          attempt,
          status: response.status,
          eventId: body.data[0]?.event_id,
          eventsReceived: parsed?.events_received,
          testMode: Boolean(testEventCode),
        });
        return {
          outcome: "sent",
          attempts,
          status: response.status,
          body: lastBody,
          fbtraceId: parsed?.fbtrace_id,
          eventsReceived: parsed?.events_received,
        };
      }

      const parsedError = safeJson<MetaErrorResponse>(rawBody);
      const fbtraceId = parsedError?.error?.fbtrace_id;

      if (!isRetryableStatus(response.status)) {
        log.error("meta.permanent_failure", {
          attempt,
          status: response.status,
          eventId: body.data[0]?.event_id,
          metaErrorCode: parsedError?.error?.code,
          metaErrorSubcode: parsedError?.error?.error_subcode,
        });
        return {
          outcome: "permanent_failure",
          attempts,
          status: response.status,
          body: lastBody,
          fbtraceId,
        };
      }

      log.warn("meta.retryable_failure", {
        attempt,
        status: response.status,
        eventId: body.data[0]?.event_id,
      });

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (
        !(await waitBeforeNextAttempt({
          attempt,
          maxAttempts: app.META_MAX_ATTEMPTS,
          budget: options.budget,
          sleep,
          random,
          baseMs: app.META_RETRY_BASE_MS,
          maxMs: app.META_RETRY_MAX_DELAY_MS,
          overrideDelayMs: retryAfterMs,
          timeoutMs,
        }))
      ) {
        return {
          outcome: attempt >= app.META_MAX_ATTEMPTS ? "retryable_failure" : "budget_exhausted",
          attempts,
          status: lastStatus,
          body: lastBody,
          fbtraceId,
        };
      }
    } catch (error) {
      // Timeout albo błąd sieci — traktujemy jak 5xx.
      lastError = error instanceof Error ? `${error.name}: ${redact(error.message)}` : "unknown_error";
      log.warn("meta.network_failure", {
        attempt,
        eventId: body.data[0]?.event_id,
        error: lastError,
      });

      if (
        !(await waitBeforeNextAttempt({
          attempt,
          maxAttempts: app.META_MAX_ATTEMPTS,
          budget: options.budget,
          sleep,
          random,
          baseMs: app.META_RETRY_BASE_MS,
          maxMs: app.META_RETRY_MAX_DELAY_MS,
          timeoutMs,
        }))
      ) {
        return {
          outcome: attempt >= app.META_MAX_ATTEMPTS ? "retryable_failure" : "budget_exhausted",
          attempts,
          status: lastStatus,
          body: lastBody,
          error: lastError,
        };
      }
    }
  }

  return {
    outcome: "retryable_failure",
    attempts,
    status: lastStatus,
    body: lastBody,
    error: lastError,
  };
}

/**
 * Odczekuje przed kolejną próbą.
 * @returns `false`, gdy nie ma sensu próbować dalej (koniec prób albo budżetu).
 */
async function waitBeforeNextAttempt(params: {
  attempt: number;
  maxAttempts: number;
  budget: TimeBudget;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  baseMs: number;
  maxMs: number;
  timeoutMs: number;
  overrideDelayMs?: number;
}): Promise<boolean> {
  if (params.attempt >= params.maxAttempts) return false;

  const delay =
    params.overrideDelayMs ??
    backoffDelayMs(params.attempt, {
      baseMs: params.baseMs,
      maxMs: params.maxMs,
      random: params.random,
    });

  // Czekamy tylko wtedy, gdy po odczekaniu zostanie jeszcze czas na próbę.
  if (!params.budget.hasAtLeast(delay + params.timeoutMs + 500)) return false;

  await params.sleep(delay);
  return true;
}

function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
