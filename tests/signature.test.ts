import { createHmac } from "node:crypto";

import { Webhook } from "svix";
import { describe, expect, it } from "vitest";

import { hasValidBearer, timingSafeCompare } from "@/lib/auth/secret";
import { mailgunAdapter, verifyMailgunSignature } from "@/lib/mail/providers/mailgun";
import { resendAdapter } from "@/lib/mail/providers/resend";

import { TEST_CRON_SECRET, TEST_WEBHOOK_SECRET } from "./setup";

/* ------------------------------------------------------------------ Mailgun -- */

function mailgunSignature(timestamp: string, token: string, key = TEST_WEBHOOK_SECRET): string {
  return createHmac("sha256", key).update(`${timestamp}${token}`).digest("hex");
}

describe("verifyMailgunSignature", () => {
  const now = 1_800_000_000;
  const timestamp = String(now);
  const token = "0123456789abcdef0123456789abcdef01234567";

  it("przyjmuje poprawny podpis", () => {
    const result = verifyMailgunSignature(
      { timestamp, token, signature: mailgunSignature(timestamp, token) },
      TEST_WEBHOOK_SECRET,
      { nowSeconds: now },
    );
    expect(result.ok).toBe(true);
  });

  it("odrzuca podpis policzony innym kluczem", () => {
    const result = verifyMailgunSignature(
      { timestamp, token, signature: mailgunSignature(timestamp, token, "inny-klucz") },
      TEST_WEBHOOK_SECRET,
      { nowSeconds: now },
    );
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("odrzuca podpis o innej długości", () => {
    const result = verifyMailgunSignature(
      { timestamp, token, signature: "krotki" },
      TEST_WEBHOOK_SECRET,
      { nowSeconds: now },
    );
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("odrzuca przeterminowany znacznik czasu (ochrona przed replay)", () => {
    const stale = String(now - 3_600);
    const result = verifyMailgunSignature(
      { timestamp: stale, token, signature: mailgunSignature(stale, token) },
      TEST_WEBHOOK_SECRET,
      { nowSeconds: now, toleranceSeconds: 300 },
    );
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("odrzuca znacznik czasu z przyszłości poza tolerancją", () => {
    const future = String(now + 3_600);
    const result = verifyMailgunSignature(
      { timestamp: future, token, signature: mailgunSignature(future, token) },
      TEST_WEBHOOK_SECRET,
      { nowSeconds: now, toleranceSeconds: 300 },
    );
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("odrzuca brak któregokolwiek pola podpisu", () => {
    expect(
      verifyMailgunSignature({ timestamp: "", token, signature: "x" }, TEST_WEBHOOK_SECRET),
    ).toEqual({ ok: false, reason: "missing_signature_fields" });

    expect(
      verifyMailgunSignature({ timestamp, token: "", signature: "x" }, TEST_WEBHOOK_SECRET),
    ).toEqual({ ok: false, reason: "missing_signature_fields" });

    expect(
      verifyMailgunSignature({ timestamp, token, signature: "" }, TEST_WEBHOOK_SECRET),
    ).toEqual({ ok: false, reason: "missing_signature_fields" });
  });

  it("odrzuca znacznik czasu, który nie jest liczbą", () => {
    expect(
      verifyMailgunSignature({ timestamp: "wczoraj", token, signature: "x" }, TEST_WEBHOOK_SECRET),
    ).toEqual({ ok: false, reason: "invalid_timestamp" });
  });
});

describe("mailgunAdapter.readAndVerify", () => {
  function buildRequest(overrides: Record<string, string> = {}, signed = true): Request {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = "abcdef0123456789abcdef0123456789abcdef01";

    const form = new FormData();
    form.set("timestamp", timestamp);
    form.set("token", token);
    form.set("signature", signed ? mailgunSignature(timestamp, token) : "0".repeat(64));
    form.set("from", "Otodom <powiadomienia@otodom.pl>");
    form.set("recipient", "leady@moja-domena.pl");
    form.set("subject", "Nowa wiadomość dotycząca Twojego ogłoszenia");
    form.set(
      "body-plain",
      "Imię i nazwisko: Anna Kowalska\nE-mail: anna@example.pl\nTelefon: 601234567",
    );
    form.set("Message-Id", "<mailgun-1@otodom.pl>");

    for (const [key, value] of Object.entries(overrides)) form.set(key, value);

    return new Request("https://example.com/api/inbound/email", { method: "POST", body: form });
  }

  it("przyjmuje poprawnie podpisany webhook i normalizuje wiadomość", async () => {
    const result = await mailgunAdapter.readAndVerify(buildRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.email.messageId).toBe("<mailgun-1@otodom.pl>");
    expect(result.email.from).toBe("Otodom <powiadomienia@otodom.pl>");
    expect(result.email.subject).toBe("Nowa wiadomość dotycząca Twojego ogłoszenia");
    expect(result.email.text).toContain("anna@example.pl");
    expect(result.email.provider).toBe("mailgun");
    expect(result.email.source).toBe("webhook");
  });

  it("odrzuca zły podpis kodem 401", async () => {
    const result = await mailgunAdapter.readAndVerify(buildRequest({}, false));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.reason).toBe("invalid_signature");
  });

  it("odrzuca żądanie bez pól podpisu", async () => {
    const form = new FormData();
    form.set("from", "powiadomienia@otodom.pl");
    const request = new Request("https://example.com/api/inbound/email", {
      method: "POST",
      body: form,
    });

    const result = await mailgunAdapter.readAndVerify(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it("gdy Message-Id brakuje, generuje deterministyczny zamiennik", async () => {
    const first = await mailgunAdapter.readAndVerify(buildRequest({ "Message-Id": "" }));
    const second = await mailgunAdapter.readAndVerify(buildRequest({ "Message-Id": "" }));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.email.messageId).toMatch(/^synthetic-[a-f0-9]{64}$/);
    expect(first.email.messageId).toBe(second.email.messageId);
  });
});

/* ------------------------------------------------------------------- Resend -- */

describe("resendAdapter.readAndVerify", () => {
  const payload = {
    type: "email.received",
    created_at: "2026-03-12T09:41:17.000Z",
    data: {
      email_id: "e1",
      from: "Otodom <powiadomienia@otodom.pl>",
      to: ["leady@moja-domena.pl"],
      subject: "Nowa wiadomość dotycząca Twojego ogłoszenia",
      text: "Imię i nazwisko: Anna Kowalska\nE-mail: anna@example.pl\nTelefon: 601234567",
      headers: [
        { name: "Message-Id", value: "<resend-1@otodom.pl>" },
        { name: "Date", value: "Thu, 12 Mar 2026 09:41:17 +0000" },
      ],
    },
  };

  function signedRequest(body: unknown, { tamper = false } = {}): Request {
    const raw = JSON.stringify(body);
    const messageId = "msg_2abc";
    const timestamp = new Date();
    const signature = new Webhook(TEST_WEBHOOK_SECRET).sign(messageId, timestamp, raw);

    return new Request("https://example.com/api/inbound/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": messageId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": tamper ? "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" : signature,
      },
      body: raw,
    });
  }

  it("przyjmuje poprawnie podpisany webhook", async () => {
    const result = await resendAdapter.readAndVerify(signedRequest(payload));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.email.messageId).toBe("<resend-1@otodom.pl>");
    expect(result.email.from).toBe("Otodom <powiadomienia@otodom.pl>");
    expect(result.email.to).toEqual(["leady@moja-domena.pl"]);
    expect(result.email.text).toContain("anna@example.pl");
    expect(result.email.provider).toBe("resend");
  });

  it("odrzuca podrobiony podpis kodem 401", async () => {
    const result = await resendAdapter.readAndVerify(signedRequest(payload, { tamper: true }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.reason).toBe("invalid_signature");
  });

  it("odrzuca żądanie bez nagłówków podpisu", async () => {
    const request = new Request("https://example.com/api/inbound/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await resendAdapter.readAndVerify(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.reason).toBe("missing_signature_headers");
  });

  it("odrzuca podpis policzony dla innej treści (podmieniony payload)", async () => {
    const raw = JSON.stringify(payload);
    const messageId = "msg_2abc";
    const timestamp = new Date();
    const signature = new Webhook(TEST_WEBHOOK_SECRET).sign(messageId, timestamp, raw);

    const request = new Request("https://example.com/api/inbound/email", {
      method: "POST",
      headers: {
        "svix-id": messageId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
      // Podpis pasuje do `payload`, ale wysyłamy coś innego.
      body: JSON.stringify({ ...payload, data: { ...payload.data, subject: "Podmienione" } }),
    });

    const result = await resendAdapter.readAndVerify(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it("ignoruje zdarzenia wychodzące (email.sent) bez traktowania ich jak błędu", async () => {
    const result = await resendAdapter.readAndVerify(
      signedRequest({ ...payload, type: "email.sent" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.reason).toContain("ignored_event_type");
  });

  it("obsługuje nagłówki podane jako obiekt zamiast tablicy", async () => {
    const result = await resendAdapter.readAndVerify(
      signedRequest({
        ...payload,
        data: {
          ...payload.data,
          headers: { "Message-Id": "<obiekt-1@otodom.pl>" },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.messageId).toBe("<obiekt-1@otodom.pl>");
  });
});

/* -------------------------------------------------------------- CRON_SECRET -- */

describe("hasValidBearer", () => {
  function request(header?: string): Request {
    return new Request("https://example.com/api/cron/poll-imap", {
      headers: header ? { authorization: header } : {},
    });
  }

  it("przyjmuje poprawny nagłówek", () => {
    expect(hasValidBearer(request(`Bearer ${TEST_CRON_SECRET}`), TEST_CRON_SECRET)).toBe(true);
  });

  it("jest niewrażliwy na wielkość słowa Bearer", () => {
    expect(hasValidBearer(request(`bearer ${TEST_CRON_SECRET}`), TEST_CRON_SECRET)).toBe(true);
  });

  it("odrzuca zły sekret", () => {
    expect(hasValidBearer(request("Bearer nieprawidlowy"), TEST_CRON_SECRET)).toBe(false);
  });

  it("odrzuca brak nagłówka", () => {
    expect(hasValidBearer(request(), TEST_CRON_SECRET)).toBe(false);
  });

  it("odrzuca inny schemat uwierzytelnienia", () => {
    expect(hasValidBearer(request(`Basic ${TEST_CRON_SECRET}`), TEST_CRON_SECRET)).toBe(false);
  });
});

describe("timingSafeCompare", () => {
  it("porównuje poprawnie mimo różnych długości", () => {
    expect(timingSafeCompare("abc", "abc")).toBe(true);
    expect(timingSafeCompare("abc", "abcd")).toBe(false);
    expect(timingSafeCompare("", "")).toBe(true);
  });
});
