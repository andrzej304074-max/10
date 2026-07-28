import { Webhook, WebhookVerificationError } from "svix";

import { getInboundConfig } from "@/lib/config/env";
import { logger } from "@/lib/logger";

import { parseRawEmail, syntheticMessageId } from "../parse-raw";
import type { NormalizedInboundEmail } from "../types";
import type { InboundAdapter, InboundVerificationResult } from "./types";

/**
 * Nagłówki podpisu. Resend wysyła wariant `svix-*`; standard Standard Webhooks
 * dopuszcza też `webhook-*`. Przekazujemy oba, jeśli są obecne — biblioteka
 * svix sama wybierze właściwy.
 */
const SIGNATURE_HEADERS = [
  "svix-id",
  "svix-timestamp",
  "svix-signature",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
];

function collectSignatureHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of SIGNATURE_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function hasCompleteSignature(headers: Record<string, string>): boolean {
  const svix = headers["svix-id"] && headers["svix-timestamp"] && headers["svix-signature"];
  const webhook =
    headers["webhook-id"] && headers["webhook-timestamp"] && headers["webhook-signature"];
  return Boolean(svix || webhook);
}

/* ---------------------------------------------------- normalizacja payloadu -- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Adres bywa stringiem, obiektem `{address,name}` albo tablicą jednego i drugiego. */
function toAddressString(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map(toAddressString).filter(Boolean).join(", ");
  }

  const record = asRecord(value);
  if (!record) return "";

  const address = typeof record.address === "string" ? record.address : undefined;
  const email = typeof record.email === "string" ? record.email : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  const resolved = address ?? email;

  if (!resolved) return "";
  return name ? `${name} <${resolved}>` : resolved;
}

function toAddressList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(toAddressString).filter(Boolean);

  const single = toAddressString(value);
  return single ? [single] : [];
}

/** Nagłówki bywają obiektem albo tablicą `{name,value}`. */
function toHeaderRecord(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};

  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry);
      const name = record?.name ?? record?.key;
      if (typeof name === "string" && record?.value !== undefined) {
        headers[name.toLowerCase()] = String(record.value);
      }
    }
    return headers;
  }

  const record = asRecord(value);
  if (record) {
    for (const [name, item] of Object.entries(record)) {
      if (item !== undefined && item !== null) headers[name.toLowerCase()] = String(item);
    }
  }

  return headers;
}

function toDate(...candidates: unknown[]): Date | undefined {
  for (const candidate of candidates) {
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return candidate;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      // Sekundy czy milisekundy — rozstrzygamy po rzędzie wielkości.
      return new Date(candidate < 1e12 ? candidate * 1000 : candidate);
    }
  }
  return undefined;
}

/**
 * Zamienia payload webhooka Resend na wspólny format.
 *
 * Świadomie tolerancyjne: struktura payloadu inbound parse bywa doprecyzowywana
 * przez dostawcę, więc każde pole ma kilka akceptowanych nazw i typów zamiast
 * jednej sztywnej ścieżki.
 */
export async function normalizeResendPayload(
  payload: unknown,
): Promise<NormalizedInboundEmail | undefined> {
  const root = asRecord(payload);
  if (!root) return undefined;

  const data = asRecord(root.data) ?? root;

  // Jeśli dostajemy surowy MIME, mailparser wyciągnie z niego więcej niż my.
  const raw = data.raw ?? data.raw_email ?? data.mime;
  if (typeof raw === "string" && raw.includes("\n")) {
    return parseRawEmail(raw, {
      source: "webhook",
      provider: "resend",
      fallbackDate: toDate(data.created_at, root.created_at) ?? new Date(),
    });
  }

  const headers = toHeaderRecord(data.headers);
  const from = toAddressString(data.from ?? data.sender ?? headers.from);
  const subject = typeof data.subject === "string" ? data.subject : (headers.subject ?? "");
  const text = typeof data.text === "string" ? data.text : undefined;
  const html = typeof data.html === "string" ? data.html : undefined;

  const date =
    toDate(headers.date, data.created_at, root.created_at, data.date) ?? new Date();

  const headerMessageId =
    typeof headers["message-id"] === "string" ? headers["message-id"].trim() : "";
  const idFromPayload =
    typeof data.email_id === "string"
      ? data.email_id
      : typeof data.id === "string"
        ? data.id
        : undefined;

  const messageId =
    headerMessageId ||
    (idFromPayload ? `resend-${idFromPayload}` : "") ||
    syntheticMessageId({ from, subject, date, body: text ?? html });

  if (!from && !text && !html) return undefined;

  return {
    messageId,
    from,
    to: toAddressList(data.to ?? headers.to),
    subject,
    text,
    html,
    date,
    headers,
    source: "webhook",
    provider: "resend",
  };
}

/* ------------------------------------------------------------------ adapter -- */

export const resendAdapter: InboundAdapter = {
  name: "resend",

  async readAndVerify(request: Request): Promise<InboundVerificationResult> {
    const { INBOUND_WEBHOOK_SECRET } = getInboundConfig();

    const signatureHeaders = collectSignatureHeaders(request);
    if (!hasCompleteSignature(signatureHeaders)) {
      return { ok: false, status: 401, reason: "missing_signature_headers" };
    }

    // Svix podpisuje DOKŁADNIE surowe ciało — nie wolno go wcześniej sparsować.
    const rawBody = await request.text();

    let verified: unknown;
    try {
      verified = new Webhook(INBOUND_WEBHOOK_SECRET).verify(rawBody, signatureHeaders);
    } catch (error) {
      logger.warn("inbound.signature_invalid", {
        provider: "resend",
        error: error instanceof WebhookVerificationError ? error.message : "verification_failed",
      });
      return { ok: false, status: 401, reason: "invalid_signature" };
    }

    const root = asRecord(verified);
    const eventType = typeof root?.type === "string" ? root.type : undefined;

    // Resend wysyła też zdarzenia wychodzące (email.sent, email.delivered…).
    if (eventType && !eventType.startsWith("email.received") && !eventType.startsWith("inbound")) {
      return { ok: false, status: 400, reason: `ignored_event_type:${eventType}` };
    }

    const email = await normalizeResendPayload(verified);
    if (!email) return { ok: false, status: 400, reason: "unrecognized_payload" };

    return { ok: true, email };
  },
};
