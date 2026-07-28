import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  backoffDelayMs,
  isRetryableStatus,
  metaEndpoint,
  sendLeadEvent,
} from "@/lib/meta/client";
import type { MetaEventsRequestBody } from "@/lib/meta/types";
import { TimeBudget, unlimitedBudget } from "@/lib/time-budget";

const BODY: MetaEventsRequestBody = {
  data: [
    {
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: "a".repeat(64),
      action_source: "system_generated",
      event_source_url: "https://www.otodom.pl/pl/oferta/hala-ID1",
      user_data: { em: ["b".repeat(64)] },
      custom_data: { lead_source: "otodom", listing_id: "1", content_name: "Hala" },
    },
  ],
};

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Kolejka odpowiedzi — jedna na próbę. */
function queuedFetch(responses: Array<Response | Error>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fetch wywołany więcej razy niż przygotowano odpowiedzi");
    if (next instanceof Error) throw next;
    return next;
  });
}

const noSleep = vi.fn(async () => {});
const noJitter = () => 0;

beforeEach(() => {
  noSleep.mockClear();
});

describe("isRetryableStatus", () => {
  it("ponawia 429 i 5xx", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it("nie ponawia pozostałych 4xx", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("rośnie wykładniczo", () => {
    const options = { baseMs: 500, maxMs: 8_000, random: () => 1 };
    expect(backoffDelayMs(1, options)).toBe(500);
    expect(backoffDelayMs(2, options)).toBe(1_000);
    expect(backoffDelayMs(3, options)).toBe(2_000);
  });

  it("nie przekracza maksimum", () => {
    const options = { baseMs: 500, maxMs: 8_000, random: () => 1 };
    expect(backoffDelayMs(10, options)).toBe(8_000);
  });

  it("stosuje jitter — wynik mieści się między połową a pełną wartością", () => {
    expect(backoffDelayMs(3, { baseMs: 500, maxMs: 8_000, random: () => 0 })).toBe(1_000);
    expect(backoffDelayMs(3, { baseMs: 500, maxMs: 8_000, random: () => 1 })).toBe(2_000);
  });
});

describe("metaEndpoint", () => {
  it("składa adres z wersji API i identyfikatora zestawu danych", () => {
    expect(metaEndpoint("v21.0", "1062762802819993")).toBe(
      "https://graph.facebook.com/v21.0/1062762802819993/events",
    );
  });
});

describe("sendLeadEvent — polityka ponawiania", () => {
  it("sukces za pierwszym razem", async () => {
    const fetchImpl = queuedFetch([
      jsonResponse(200, { events_received: 1, fbtrace_id: "trace-1" }),
    ]);

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    expect(result.outcome).toBe("sent");
    expect(result.attempts).toBe(1);
    expect(result.eventsReceived).toBe(1);
    expect(result.fbtraceId).toBe("trace-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("ponawia po 5xx i kończy sukcesem", async () => {
    const fetchImpl = queuedFetch([
      jsonResponse(500, { error: { message: "internal" } }),
      jsonResponse(503, { error: { message: "unavailable" } }),
      jsonResponse(200, { events_received: 1 }),
    ]);

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
      randomImpl: noJitter,
    });

    expect(result.outcome).toBe("sent");
    expect(result.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("nie ponawia 4xx i zgłasza błąd trwały", async () => {
    const fetchImpl = queuedFetch([
      jsonResponse(400, { error: { message: "Invalid parameter", code: 100 } }),
    ]);

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    expect(result.outcome).toBe("permanent_failure");
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("nie ponawia 401 (zły token)", async () => {
    const fetchImpl = queuedFetch([jsonResponse(401, { error: { message: "Invalid OAuth token" } })]);

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    expect(result.outcome).toBe("permanent_failure");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ponawia 429 uwzględniając nagłówek Retry-After", async () => {
    const fetchImpl = queuedFetch([
      jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "2" }),
      jsonResponse(200, { events_received: 1 }),
    ]);

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    expect(result.outcome).toBe("sent");
    expect(noSleep).toHaveBeenCalledWith(2_000);
  });

  it("zatrzymuje się po META_MAX_ATTEMPTS próbach", async () => {
    const fetchImpl = queuedFetch(
      Array.from({ length: 5 }, () => jsonResponse(500, { error: { message: "boom" } })),
    );

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
      randomImpl: noJitter,
    });

    expect(result.outcome).toBe("retryable_failure");
    expect(result.attempts).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    // Po ostatniej próbie już nie czekamy.
    expect(noSleep).toHaveBeenCalledTimes(4);
  });

  it("ponawia błędy sieci i timeouty", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";

    const fetchImpl = queuedFetch([timeout, jsonResponse(200, { events_received: 1 })]);

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
      randomImpl: noJitter,
    });

    expect(result.outcome).toBe("sent");
    expect(result.attempts).toBe(2);
  });
});

describe("sendLeadEvent — budżet czasu funkcji", () => {
  it("nie próbuje w ogóle, gdy budżet jest już wyczerpany", async () => {
    const fetchImpl = queuedFetch([jsonResponse(200, {})]);

    const result = await sendLeadEvent(BODY, {
      budget: new TimeBudget(1_000, 900),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    expect(result.outcome).toBe("budget_exhausted");
    expect(result.attempts).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("przerywa ponawianie, gdy w budżecie zabraknie czasu na kolejną próbę", async () => {
    // Zegar sterowany ręcznie: każda próba zjada 8 s, sleep przesuwa czas.
    let now = 0;
    const clock = () => now;

    const fetchImpl = vi.fn(async () => {
      now += 8_000;
      return jsonResponse(500, { error: { message: "boom" } });
    });
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
    });

    const result = await sendLeadEvent(BODY, {
      budget: new TimeBudget(30_000, 5_000, clock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
      randomImpl: noJitter,
    });

    // Zabrakło czasu zanim wyczerpaliśmy 5 prób — zdarzenie zostanie `pending`.
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.attempts).toBeLessThan(5);
    expect(result.attempts).toBeGreaterThan(0);
  });
});

describe("sendLeadEvent — bezpieczeństwo", () => {
  it("wysyła token w ciele żądania, ale nie zwraca go w wyniku", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      // Odpowiedź celowo zawiera token — musi zostać wycięty z zapisu.
      return jsonResponse(400, {
        error: { message: "Bad request for access_token=SEKRETNY_TOKEN" },
      });
    });

    const result = await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    expect(capturedBody).toContain("TESTOWY_TOKEN_NIE_JEST_PRAWDZIWY");
    expect(result.body).toContain("access_token=***");
    expect(result.body).not.toContain("SEKRETNY_TOKEN");
  });

  it("uderza w poprawny endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://graph.facebook.com/v21.0/1062762802819993/events");
      return jsonResponse(200, { events_received: 1 });
    });

    await sendLeadEvent(BODY, {
      budget: unlimitedBudget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
