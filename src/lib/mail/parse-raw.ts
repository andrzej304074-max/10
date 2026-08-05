import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

import { sha256Hex } from "@/lib/hashing/hash";

import { SYNTHETIC_MESSAGE_ID_PREFIX, type NormalizedInboundEmail } from "./types";

function addressesToList(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => entry.value.map((item) => item.address ?? "").filter(Boolean));
}

function headersToRecord(parsed: ParsedMail): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (value && typeof value === "object" && "text" in value) {
      headers[key.toLowerCase()] = String((value as { text?: unknown }).text ?? "");
    }
  }
  return headers;
}

/**
 * Deterministyczny zamiennik Message-ID.
 *
 * Musi być deterministyczny, bo ta sama wiadomość może dotrzeć webhookiem
 * i przez IMAP — a idempotencja opiera się właśnie na tym identyfikatorze.
 * Dlatego liczymy go z niezmiennych cech wiadomości, nie z czasu przetwarzania.
 */
export function syntheticMessageId(parts: {
  from?: string;
  subject?: string;
  date?: Date;
  body?: string;
}): string {
  const fingerprint = [
    parts.from ?? "",
    parts.subject ?? "",
    parts.date ? String(Math.floor(parts.date.getTime() / 1000)) : "",
    (parts.body ?? "").slice(0, 512),
  ].join("|");

  return `${SYNTHETIC_MESSAGE_ID_PREFIX}${sha256Hex(fingerprint)}`;
}

/**
 * Czy wejście wygląda na surowy MIME (ma nagłówki), czy na samą treść.
 * Pozwala przyjąć jedno i drugie tam, gdzie użytkownik wkleja cokolwiek.
 */
export function looksLikeMime(input: string): boolean {
  const head = input.slice(0, 2_000);
  return /^(?:From|To|Subject|Date|Message-ID|Received|MIME-Version|Content-Type):/im.test(head);
}

export interface ParseRawOptions {
  source: NormalizedInboundEmail["source"];
  provider: string;
  /** Data odbioru — używana, gdy wiadomość nie ma nagłówka Date. */
  fallbackDate?: Date;
}

/** Parsuje surowy MIME (IMAP, `body-mime` z Mailguna, `raw` z Resend). */
export async function parseRawEmail(
  raw: string | Buffer,
  options: ParseRawOptions,
): Promise<NormalizedInboundEmail> {
  const parsed = await simpleParser(raw);

  const from = parsed.from?.text ?? "";
  const subject = parsed.subject ?? "";
  const text = parsed.text ?? undefined;
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const date = parsed.date ?? options.fallbackDate ?? new Date();

  const messageId =
    parsed.messageId?.trim() ||
    syntheticMessageId({ from, subject, date, body: text ?? html });

  return {
    messageId,
    from,
    to: addressesToList(parsed.to),
    subject,
    text,
    html,
    date,
    headers: headersToRecord(parsed),
    source: options.source,
    provider: options.provider,
  };
}
