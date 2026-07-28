import {
  ALL_LABELS,
  EMAIL_GENERIC,
  EMPTY_VALUE_MARKERS,
  EXCLUDED_EMAIL_LOCALPARTS,
  FIELD_PATTERNS,
  LISTING_ID_FROM_URL_PATTERNS,
  LISTING_URL_PATTERNS,
  MESSAGE_PATTERN,
  PHONE_GENERIC,
  TRACKING_QUERY_PARAMS,
  excludedEmailDomains,
} from "@/lib/config/patterns";
import { normalizeEmail, normalizePhoneDetailed, splitFullName } from "@/lib/hashing/normalize";
import { logger, type Logger } from "@/lib/logger";

import { htmlToText } from "./html-to-text";
import type { LeadField, LeadSourceDocument, ParsedLead } from "./types";

/* ------------------------------------------------------- walidacja wartości -- */

const LABEL_PREFIX = new RegExp(
  `^(?:${ALL_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[\\t ]*[:\\uff1a]`,
  "i",
);

/** Obcina ozdobniki, które przetrwały konwersję z HTML-a. */
function tidy(value: string): string {
  return value
    .replace(/^[\s>*|·•-]+/, "")
    .replace(/[\s|]+$/, "")
    .trim();
}

/**
 * Odrzuca wartości, które w rzeczywistości oznaczają „pole puste” albo są
 * etykietą kolejnego wiersza (to się zdarza, gdy Otodom pominie pusty wiersz).
 */
function isUsableValue(value: string): boolean {
  const cleaned = tidy(value);
  if (cleaned.length === 0) return false;
  if (EMPTY_VALUE_MARKERS.includes(cleaned.toLowerCase())) return false;
  if (LABEL_PREFIX.test(cleaned)) return false;
  return true;
}

/** Kopia wzorca z flagą `g` — pozwala iterować, nie mutując oryginału. */
function global(pattern: RegExp): RegExp {
  return pattern.flags.includes("g")
    ? new RegExp(pattern.source, pattern.flags)
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

/**
 * Pierwsza sensowna wartość dla danego pola.
 *
 * Iterujemy po WSZYSTKICH dopasowaniach, nie tylko pierwszym: w przekazanej
 * wiadomości nagłówek „Od: Otodom <powiadomienia@otodom.pl>” trafia w etykietę
 * imienia wcześniej niż właściwe „Imię i nazwisko:”. Walidator odrzuca taką
 * wartość, a pętla leci dalej zamiast poddać się na pierwszym trafieniu.
 */
function firstMatch(
  texts: string[],
  patterns: RegExp[],
  { group = 1, validate }: { group?: number; validate?: (value: string) => boolean } = {},
): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of patterns) {
      for (const match of text.matchAll(global(pattern))) {
        const captured = match[group];
        if (!captured) continue;

        const cleaned = tidy(captured);
        if (!isUsableValue(cleaned)) continue;
        if (validate && !validate(cleaned)) continue;

        return cleaned;
      }
    }
  }
  return undefined;
}

/** Wszystkie dopasowania wzorca globalnego (bez mutowania `lastIndex` oryginału). */
function allMatches(texts: string[], pattern: RegExp): string[] {
  const results: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(global(pattern))) {
      if (match[0]) results.push(match[0]);
    }
  }
  return results;
}

/**
 * Czy wartość wygląda na imię i nazwisko osoby.
 * Odsiewa adresy e-mail, adresy URL i resztki nagłówków przekazanej wiadomości.
 */
function looksLikePersonName(value: string): boolean {
  if (value.includes("@") || value.includes("<") || /https?:\/\//i.test(value)) return false;
  if (!/\p{L}/u.test(value)) return false;
  return value.length >= 2 && value.length <= 120;
}

/* ---------------------------------------------------------------- e-mail -- */

function isExcludedEmail(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0) return true;

  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();

  if (EXCLUDED_EMAIL_LOCALPARTS.test(local)) return true;

  return excludedEmailDomains().some(
    (excluded) => domain === excluded || domain.endsWith(`.${excluded}`),
  );
}

function isUsableLeadEmail(candidate: string): boolean {
  const normalized = normalizeEmail(candidate);
  return Boolean(normalized && !isExcludedEmail(normalized));
}

function extractEmail(texts: string[]): { value?: string; source?: "label" | "fallback" } {
  const labelled = firstMatch(texts, FIELD_PATTERNS.email.labelled, {
    validate: isUsableLeadEmail,
  });

  const fromLabel = normalizeEmail(labelled);
  if (fromLabel) return { value: fromLabel, source: "label" };

  for (const candidate of allMatches(texts, EMAIL_GENERIC)) {
    const normalized = normalizeEmail(candidate);
    if (normalized && !isExcludedEmail(normalized)) {
      return { value: normalized, source: "fallback" };
    }
  }

  return {};
}

/* --------------------------------------------------------------- telefon -- */

function extractPhone(
  texts: string[],
  defaultCountry: string,
): { value?: string; source?: "label" | "fallback"; reason?: string } {
  let labelReason: string | undefined;

  // Walidator zapamiętuje powód pierwszego odrzucenia — trafi do logu, gdy
  // ostatecznie nie uda się wyciągnąć żadnego numeru.
  const labelled = firstMatch(texts, FIELD_PATTERNS.phone.labelled, {
    validate: (value) => {
      const result = normalizePhoneDetailed(value, defaultCountry);
      if (result.value) return true;
      labelReason ??= result.reason;
      return false;
    },
  });

  if (labelled) {
    const result = normalizePhoneDetailed(labelled, defaultCountry);
    if (result.value) return { value: result.value, source: "label" };
  }

  for (const candidate of allMatches(texts, PHONE_GENERIC)) {
    // Numery zbyt krótkie (rok, kod pocztowy, ID) odsiewa normalizator;
    // tu odrzucamy tylko oczywiste ciągi wyglądające na rok.
    if (/^\s*(?:19|20)\d{2}\s*$/.test(candidate)) continue;

    const result = normalizePhoneDetailed(candidate, defaultCountry);
    if (result.value) return { value: result.value, source: "fallback" };
  }

  return { reason: labelReason };
}

/* ------------------------------------------------------------ ogłoszenie -- */

/**
 * Rozpakowuje adres z click-trackera, jeśli prawdziwy URL siedzi w parametrze.
 * Dostawcy poczty masowej często opakowują linki we własną domenę.
 */
function unwrapTrackingUrl(url: URL): URL {
  for (const key of ["url", "u", "target", "redirect", "redirect_url", "link"]) {
    const nested = url.searchParams.get(key);
    if (!nested) continue;
    try {
      const parsed = new URL(decodeURIComponent(nested));
      if (/(?:^|\.)otodom\.pl$/i.test(parsed.hostname)) return parsed;
    } catch {
      // parametr nie był adresem — ignorujemy
    }
  }
  return url;
}

function cleanListingUrl(raw: string): string | undefined {
  const trimmed = raw.replace(/[.,;:!?)\]}"'>]+$/, "");
  try {
    const parsed = unwrapTrackingUrl(new URL(trimmed));
    for (const param of TRACKING_QUERY_PARAMS) parsed.searchParams.delete(param);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function extractListingUrl(texts: string[]): string | undefined {
  const candidates: string[] = [];
  for (const pattern of LISTING_URL_PATTERNS) {
    candidates.push(...allMatches(texts, pattern));
  }

  const cleaned = candidates
    .map(cleanListingUrl)
    .filter((url): url is string => Boolean(url));

  // Najpierw właściwa oferta, dopiero potem cokolwiek z domeny otodom.pl.
  return cleaned.find((url) => /\/(?:oferta|offer)\//i.test(url)) ?? cleaned[0];
}

function extractListingIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  for (const pattern of LISTING_ID_FROM_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/* --------------------------------------------------------------- parser -- */

export interface ParseOptions {
  /** Domyślny kraj dla normalizacji telefonu (ISO alpha-2). */
  defaultCountry?: string;
  log?: Logger;
}

/**
 * Wyciąga dane leada z maila Otodom.
 *
 * Kolejność źródeł: wersja text/plain → wersja HTML zamieniona na tekst →
 * surowy HTML (tylko dla adresów URL, bo linki bywają wyłącznie w `href`).
 * Dla każdego pola: wzorce etykietowe, a gdy zawiodą — wzorzec awaryjny.
 */
export function parseOtodomLead(
  document: LeadSourceDocument,
  { defaultCountry = "PL", log = logger }: ParseOptions = {},
): ParsedLead {
  const plain = document.text?.trim() ?? "";
  const fromHtml = document.html ? htmlToText(document.html) : "";

  /** Kandydaci tekstowi dla wzorców etykietowych — od najczystszego. */
  const texts = [plain, fromHtml].filter((text) => text.length > 0);
  /** Do szukania adresów bierzemy dodatkowo surowy HTML. */
  const urlTexts = [...texts, document.html ?? ""].filter((text) => text.length > 0);

  const sources: ParsedLead["sources"] = {};
  const missingFields: LeadField[] = [];

  const fullName = firstMatch(texts, FIELD_PATTERNS.fullName.labelled, {
    validate: looksLikePersonName,
  });
  if (fullName) sources.fullName = "label";

  const { firstName, lastName } = splitFullName(fullName);
  if (firstName) sources.firstName = "derived";
  if (lastName) sources.lastName = "derived";

  const email = extractEmail(texts);
  if (email.source) sources.email = email.source;

  const phone = extractPhone(texts, defaultCountry);
  if (phone.source) sources.phone = phone.source;

  const message = firstMatch(texts, [MESSAGE_PATTERN]);
  if (message) sources.message = "label";

  const listingUrl = extractListingUrl(urlTexts);
  if (listingUrl) sources.listingUrl = "fallback";

  const listingIdFromLabel = firstMatch(texts, FIELD_PATTERNS.listingId.labelled);
  const listingId = listingIdFromLabel ?? extractListingIdFromUrl(listingUrl);
  if (listingId) sources.listingId = listingIdFromLabel ? "label" : "derived";

  const listingTitleFromLabel = firstMatch(texts, FIELD_PATTERNS.listingTitle.labelled);
  const listingTitle = listingTitleFromLabel ?? (document.subject?.trim() || undefined);
  if (listingTitle) sources.listingTitle = listingTitleFromLabel ? "label" : "derived";

  const parsed: ParsedLead = {
    fullName,
    firstName,
    lastName,
    email: email.value,
    phone: phone.value,
    message: message ? message.replace(/\n{3,}/g, "\n\n").trim() : undefined,
    listingId,
    listingUrl,
    listingTitle,
    sentAt: document.date,
    missingFields,
    sources,
  };

  const CHECKED: LeadField[] = [
    "fullName",
    "firstName",
    "lastName",
    "email",
    "phone",
    "message",
    "listingId",
    "listingUrl",
    "listingTitle",
  ];

  for (const field of CHECKED) {
    if (!parsed[field]) missingFields.push(field);
  }

  if (missingFields.length > 0) {
    // Logujemy WYŁĄCZNIE nazwy pól — nigdy wartości ani fragmentów treści.
    log.warn("parser.fields_missing", {
      fields: missingFields,
      hadPlainText: plain.length > 0,
      hadHtml: fromHtml.length > 0,
      phoneRejectReason: phone.reason,
    });
  }

  log.debug("parser.done", {
    resolved: Object.keys(sources),
    sources,
  });

  return parsed;
}
