import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SendResult } from "@/lib/meta/client";
import type { MetaEventsRequestBody } from "@/lib/meta/types";
import { unlimitedBudget } from "@/lib/time-budget";

/**
 * Baza jest podmieniona w całości — te testy sprawdzają mapowanie wyniku
 * wysyłki na stan zapisany w bazie, a nie samo SQL-owe zachowanie.
 */
vi.mock("@/lib/db/queries", () => ({
  updateLeadEventResult: vi.fn(async () => {}),
  upsertDeadLetter: vi.fn(async () => {}),
  resolveDeadLetter: vi.fn(async () => {}),
  getLeadEvent: vi.fn(async () => undefined),
  listRetryableEvents: vi.fn(async () => []),
}));

const queries = await import("@/lib/db/queries");
const { deliverEvent } = await import("@/lib/pipeline/deliver");

const EVENT_ID = "c".repeat(64);
const MESSAGE_ID = "<msg-1@otodom.pl>";

function body(eventTimeSeconds = Math.floor(Date.now() / 1000)): MetaEventsRequestBody {
  return {
    data: [
      {
        event_name: "Lead",
        event_time: eventTimeSeconds,
        event_id: EVENT_ID,
        action_source: "system_generated",
        event_source_url: "https://www.otodom.pl/pl/oferta/hala-ID1",
        user_data: { em: ["d".repeat(64)] },
        custom_data: { lead_source: "otodom", listing_id: "1", content_name: "Hala" },
      },
    ],
  };
}

function sendResult(overrides: Partial<SendResult> & Pick<SendResult, "outcome">): SendResult {
  return { attempts: 1, ...overrides };
}

beforeEach(() => {
  vi.mocked(queries.updateLeadEventResult).mockClear();
  vi.mocked(queries.upsertDeadLetter).mockClear();
  vi.mocked(queries.resolveDeadLetter).mockClear();
});

describe("deliverEvent — mapowanie wyniku na stan w bazie", () => {
  it("sukces zapisuje status 'sent' i zamyka wpis w dead-letter", async () => {
    const result = await deliverEvent(
      { eventId: EVENT_ID, messageId: MESSAGE_ID, body: body() },
      {
        budget: unlimitedBudget(),
        sendImpl: async () =>
          sendResult({ outcome: "sent", status: 200, eventsReceived: 1, fbtraceId: "t1" }),
      },
    );

    expect(result.outcome).toBe("sent");
    expect(queries.updateLeadEventResult).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ status: "sent", attempts: 1, metaResponseCode: 200 }),
    );
    expect(queries.resolveDeadLetter).toHaveBeenCalledWith(EVENT_ID, expect.any(String));
    expect(queries.upsertDeadLetter).not.toHaveBeenCalled();
  });

  it("błąd 4xx trafia do dead-letter i nie jest ponawiany", async () => {
    const result = await deliverEvent(
      { eventId: EVENT_ID, messageId: MESSAGE_ID, body: body() },
      {
        budget: unlimitedBudget(),
        sendImpl: async () =>
          sendResult({ outcome: "permanent_failure", status: 400, body: "Invalid parameter" }),
      },
    );

    expect(result.outcome).toBe("dead");
    expect(result.reason).toBe("meta_4xx");
    expect(queries.updateLeadEventResult).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ status: "dead", metaResponseCode: 400 }),
    );
    expect(queries.upsertDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, reason: "meta_4xx", errorCode: 400 }),
    );
  });

  it("wyczerpany budżet czasu zostawia zdarzenie jako 'pending'", async () => {
    const result = await deliverEvent(
      { eventId: EVENT_ID, messageId: MESSAGE_ID, body: body() },
      {
        budget: unlimitedBudget(),
        sendImpl: async () => sendResult({ outcome: "budget_exhausted", attempts: 2 }),
      },
    );

    expect(result.outcome).toBe("pending");
    expect(queries.updateLeadEventResult).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ status: "pending", attempts: 2 }),
    );
    // Zdarzenie ma zostać dokończone przez cron — nie jest to błąd trwały.
    expect(queries.upsertDeadLetter).not.toHaveBeenCalled();
  });

  it("błąd przejściowy planuje ponowienie", async () => {
    const result = await deliverEvent(
      { eventId: EVENT_ID, messageId: MESSAGE_ID, body: body() },
      {
        budget: unlimitedBudget(),
        sendImpl: async () =>
          sendResult({ outcome: "retryable_failure", attempts: 5, status: 500, body: "boom" }),
      },
    );

    expect(result.outcome).toBe("retry_scheduled");
    expect(queries.updateLeadEventResult).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ status: "failed_retryable", attempts: 5 }),
    );
    expect(queries.upsertDeadLetter).not.toHaveBeenCalled();
  });

  it("po przekroczeniu PENDING_MAX_ATTEMPTS zdarzenie ląduje w dead-letter", async () => {
    const result = await deliverEvent(
      { eventId: EVENT_ID, messageId: MESSAGE_ID, body: body(), attemptsSoFar: 12 },
      {
        budget: unlimitedBudget(),
        sendImpl: async () =>
          sendResult({ outcome: "retryable_failure", attempts: 5, status: 503, body: "boom" }),
      },
    );

    expect(result.outcome).toBe("dead");
    expect(result.reason).toBe("max_attempts_exceeded");
    expect(queries.upsertDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "max_attempts_exceeded", attempts: 17 }),
    );
  });

  it("zdarzenie starsze niż 7 dni nie jest w ogóle wysyłane", async () => {
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
    const sendImpl = vi.fn(async () => sendResult({ outcome: "sent", status: 200 }));

    const result = await deliverEvent(
      { eventId: EVENT_ID, messageId: MESSAGE_ID, body: body(eightDaysAgo) },
      { budget: unlimitedBudget(), sendImpl },
    );

    expect(result.outcome).toBe("dead");
    expect(result.reason).toBe("event_too_old");
    expect(sendImpl).not.toHaveBeenCalled();
    expect(queries.upsertDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "event_too_old" }),
    );
  });

  it("sumuje próby z wcześniejszych podejść", async () => {
    await deliverEvent(
      { eventId: EVENT_ID, messageId: MESSAGE_ID, body: body(), attemptsSoFar: 3 },
      {
        budget: unlimitedBudget(),
        sendImpl: async () => sendResult({ outcome: "sent", status: 200, attempts: 2 }),
      },
    );

    expect(queries.updateLeadEventResult).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ attempts: 5 }),
    );
  });
});
