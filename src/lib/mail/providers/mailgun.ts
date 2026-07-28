import { createHmac, timingSafeEqual } from "node:crypto";

import { getInboundConfig } from "@/lib/config/env";
import { logger } from "@/lib/logger";

import { parseRawEmail, syntheticMessageId } from "../parse-raw";
import type { NormalizedInboundEmail } from "../types";
import type { InboundAdapter, InboundVerificationResult } from "./types";

export interface MailgunSignature {
  timestamp: string;
  token: string;
  signature: string;
}

/**
 * Weryfikacja podpisu Mailguna: HMAC-SHA256 z konkatenacji `timestamp + token`,
 * kluczowany webhook signing key, wynik w hex.
 *
 * Poza samym HMAC-em sprawdzamy świeżość znacznika czasu. Bez tego przechwycony
 * request dałby się odtworzyć w nieskończoność — podpis pozostaje przecież ważny.
 */
export function verifyMailgunSignature(
  { timestamp, token, signature }: MailgunSignature,
  signingKey: string,
  { toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000) } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!timestamp || !token || !signature) {
    return { ok: false, reason: "missing_signature_fields" };
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = createHmac("sha256", signingKey).update(`${timestamp}${token}`).digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signature.toLowerCase(), "utf8");

  // timingSafeEqual wymaga równych długości — inna długość i tak oznacza brak dopasowania.
  if (expectedBuffer.length !== receivedBuffer.length) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (!timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true };
}

/* ---------------------------------------------------- normalizacja payloadu -- */

function field(form: FormData, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = form.get(name);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** `message-headers` przychodzi jako JSON z tablicą par `[nazwa, wartość]`. */
function parseMessageHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};

    const headers: Record<string, string> = {};
    for (const entry of parsed) {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        headers[entry[0].toLowerCase()] = String(entry[1] ?? "");
      }
    }
    return headers;
  } catch {
    return {};
  }
}

export async function normalizeMailgunForm(
  form: FormData,
): Promise<NormalizedInboundEmail | undefined> {
  // Trasa typu „raw MIME” podaje całą wiadomość — mailparser zrobi to lepiej.
  const rawMime = field(form, "body-mime");
  if (rawMime) {
    return parseRawEmail(rawMime, {
      source: "webhook",
      provider: "mailgun",
      fallbackDate: new Date(),
    });
  }

  const headers = parseMessageHeaders(field(form, "message-headers"));

  const from = field(form, "from", "From", "sender") ?? headers.from ?? "";
  const subject = field(form, "subject", "Subject") ?? headers.subject ?? "";
  // `stripped-text` to treść bez cytatów i stopki — dla parsera zwykle czystsza,
  // ale `body-plain` bywa jedynym miejscem z linkiem do ogłoszenia, więc łączymy.
  const bodyPlain = field(form, "body-plain");
  const strippedText = field(form, "stripped-text");
  const text = [strippedText, bodyPlain].filter(Boolean).join("\n\n") || undefined;
  const html = field(form, "body-html", "stripped-html");

  const dateHeader = headers.date ?? field(form, "Date");
  const parsedDate = dateHeader ? new Date(dateHeader) : undefined;
  const date = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date();

  const messageIdRaw = field(form, "Message-Id", "message-id") ?? headers["message-id"];
  const messageId =
    messageIdRaw?.trim() || syntheticMessageId({ from, subject, date, body: text ?? html });

  if (!from && !text && !html) return undefined;

  const recipient = field(form, "recipient", "To");

  return {
    messageId,
    from,
    to: recipient ? recipient.split(",").map((value) => value.trim()) : [],
    subject,
    text,
    html,
    date,
    headers: {
      ...headers,
      ...(recipient ? { to: recipient } : {}),
      ...(from ? { from } : {}),
    },
    source: "webhook",
    provider: "mailgun",
  };
}

/* ------------------------------------------------------------------ adapter -- */

export const mailgunAdapter: InboundAdapter = {
  name: "mailgun",

  async readAndVerify(request: Request): Promise<InboundVerificationResult> {
    const { INBOUND_WEBHOOK_SECRET, INBOUND_SIGNATURE_TOLERANCE_SECONDS } = getInboundConfig();

    let form: FormData;
    try {
      // Mailgun wysyła multipart/form-data (trasa forward) albo
      // application/x-www-form-urlencoded. `formData()` obsługuje oba.
      form = await request.formData();
    } catch {
      return { ok: false, status: 400, reason: "unparsable_form_body" };
    }

    const verification = verifyMailgunSignature(
      {
        timestamp: field(form, "timestamp") ?? "",
        token: field(form, "token") ?? "",
        signature: field(form, "signature") ?? "",
      },
      INBOUND_WEBHOOK_SECRET,
      { toleranceSeconds: INBOUND_SIGNATURE_TOLERANCE_SECONDS },
    );

    if (!verification.ok) {
      logger.warn("inbound.signature_invalid", {
        provider: "mailgun",
        reason: verification.reason,
      });
      return { ok: false, status: 401, reason: verification.reason };
    }

    const email = await normalizeMailgunForm(form);
    if (!email) return { ok: false, status: 400, reason: "unrecognized_payload" };

    return { ok: true, email };
  },
};
