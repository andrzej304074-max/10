import {
  BODY_MARKERS,
  SENDER_HEADER_CANDIDATES,
  allowedSenderDomains,
  subjectPatterns,
} from "@/lib/config/patterns";
import { htmlToText } from "@/lib/parser/html-to-text";

import type { NormalizedInboundEmail } from "./types";

export type SkipReason =
  /** Ani nadawca, ani treść nie wskazują na Otodom. */
  | "not_from_otodom"
  /** Nadawca się zgadza, ale temat nie pasuje do żadnej reguły. */
  | "subject_not_matching"
  /** Nadawca nieznany, a treść nie potwierdza pochodzenia. */
  | "sender_not_allowed"
  /** Wiadomość bez treści (sam załącznik / puste ciało). */
  | "empty_body";

export interface FilterResult {
  ok: boolean;
  reason?: SkipReason;
  /** Sygnały, które zdecydowały — do logu diagnostycznego. */
  signals: { sender: boolean; subject: boolean; body: boolean };
}

const ADDRESS_PATTERN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Adresy z nagłówka From i wszystkich nagłówków, które przetrwają forward. */
function collectSenderAddresses(email: NormalizedInboundEmail): string[] {
  const raw: string[] = [email.from];

  for (const header of SENDER_HEADER_CANDIDATES) {
    const value = email.headers[header];
    if (value) raw.push(value);
  }

  return raw
    .flatMap((value) => value.match(ADDRESS_PATTERN) ?? [])
    .map((address) => address.toLowerCase());
}

function matchesAllowedDomain(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;

  const domain = address.slice(at + 1);
  return allowedSenderDomains().some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
  );
}

/**
 * Decyduje, czy wiadomość ma zostać przetworzona.
 *
 * Bierzemy pod uwagę trzy sygnały:
 *  - `sender`  — adres z któregokolwiek nagłówka należy do dozwolonej domeny,
 *  - `subject` — temat pasuje do reguł z konfiguracji,
 *  - `body`    — treść zawiera znacznik Otodomu (np. link do ogłoszenia).
 *
 * Reguła przekazywania poczty potrafi nadpisać `From:` Twoim własnym adresem,
 * dlatego sam nadawca nie może być warunkiem koniecznym. Wystarczy więc:
 *  - nadawca z dozwolonej domeny **i** (pasujący temat **lub** znacznik w treści), albo
 *  - pasujący temat **i** znacznik w treści (klasyczny przekazany mail).
 *
 * Odrzucenie NIE jest błędem — wiadomość dostaje status `skipped` i wpis w logu.
 */
export function shouldProcessEmail(email: NormalizedInboundEmail): FilterResult {
  const bodyText = [email.text ?? "", htmlToText(email.html)].join("\n");

  const senderMatch = collectSenderAddresses(email).some(matchesAllowedDomain);
  const subjectMatch = subjectPatterns().some((pattern) => pattern.test(email.subject ?? ""));
  const bodyMatch = BODY_MARKERS.some((pattern) => pattern.test(bodyText));

  const signals = { sender: senderMatch, subject: subjectMatch, body: bodyMatch };

  if (bodyText.trim().length === 0) {
    return { ok: false, reason: "empty_body", signals };
  }

  if (senderMatch && (subjectMatch || bodyMatch)) return { ok: true, signals };
  if (subjectMatch && bodyMatch) return { ok: true, signals };

  if (!senderMatch && !bodyMatch) return { ok: false, reason: "not_from_otodom", signals };
  if (senderMatch && !subjectMatch && !bodyMatch) {
    return { ok: false, reason: "subject_not_matching", signals };
  }

  return { ok: false, reason: "sender_not_allowed", signals };
}
