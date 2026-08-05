"use server";

import { cookies } from "next/headers";

import { DASHBOARD_COOKIE, verifySessionToken } from "@/lib/auth/dashboard";
import { getAppConfig } from "@/lib/config/env";
import { hasUsableIdentifier, hashIdentity } from "@/lib/hashing/hash";
import { maskEmail, maskHash, maskName, maskPhone, maskSender } from "@/lib/hashing/mask";
import { shouldProcessEmail } from "@/lib/mail/filter";
import { looksLikeMime, parseRawEmail } from "@/lib/mail/parse-raw";
import type { NormalizedInboundEmail } from "@/lib/mail/types";
import { buildLeadEvent, buildRequestBody } from "@/lib/meta/event";
import { logger } from "@/lib/logger";

/** Wynik analizy — wyłącznie wartości bezpieczne do wyświetlenia. */
export interface ParseDiagnostics {
  ok: boolean;
  error?: string;
  message?: {
    format: string;
    from?: string;
    subject?: string;
    parts: string;
    date: string;
  };
  filter?: {
    accepted: boolean;
    reason?: string;
    signals: { sender: boolean; subject: boolean; body: boolean };
  };
  fields?: Array<{
    label: string;
    value: string;
    origin: string;
    found: boolean;
  }>;
  missingFields?: string[];
  event?: {
    eventId: string;
    eventSourceUrl: string;
    listingId: string;
    contentName: string;
    identifierCount: number;
    identifiers: string;
    payload: string;
  };
  verdict?: "sent" | "skipped" | "parse_failed";
}

const ORIGIN_LABEL: Record<string, string> = {
  label: "z etykiety",
  fallback: "wzorzec awaryjny",
  derived: "wyprowadzone",
};

/**
 * Analizuje wklejoną wiadomość dokładnie tą samą ścieżką co produkcja:
 * filtr → parser → normalizacja → haszowanie → budowa zdarzenia.
 *
 * NICZEGO nie wysyła do Meta i NICZEGO nie zapisuje w bazie. Wszystkie dane
 * osobowe w wyniku są zamaskowane — stronę można pokazać komuś przez ramię.
 */
export async function analyzeEmail(
  _previous: ParseDiagnostics | null,
  formData: FormData,
): Promise<ParseDiagnostics> {
  const store = await cookies();
  if (!verifySessionToken(store.get(DASHBOARD_COOKIE)?.value)) {
    return { ok: false, error: "Sesja wygasła. Odśwież stronę i zaloguj się ponownie." };
  }

  const input = String(formData.get("content") ?? "").trim();
  if (input.length === 0) {
    return { ok: false, error: "Wklej treść wiadomości." };
  }

  const app = getAppConfig();
  const isMime = looksLikeMime(input);

  let email: NormalizedInboundEmail;
  try {
    if (isMime) {
      email = await parseRawEmail(input, { source: "manual", provider: "dashboard" });
    } else {
      // Sama treść bez nagłówków — podstawiamy nadawcę i temat tak, żeby filtr
      // nie przesłonił wyniku parsera. O decyzji filtra informujemy osobno.
      const isHtml = /<\s*(?:html|body|table|div|p|br)\b/i.test(input);
      email = {
        messageId: "<dashboard-parser@local>",
        from: "Otodom <powiadomienia@otodom.pl>",
        to: [],
        subject: "Nowa wiadomość dotycząca Twojego ogłoszenia",
        text: isHtml ? undefined : input,
        html: isHtml ? input : undefined,
        date: new Date(),
        headers: {},
        source: "manual",
        provider: "dashboard",
      };
    }
  } catch (error) {
    logger.warn("dashboard.parser_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, error: "Nie udało się odczytać tej wiadomości. Sprawdź, czy wkleiłeś całość." };
  }

  const { parseOtodomLead } = await import("@/lib/parser/otodom");

  const filter = shouldProcessEmail(email);
  const lead = parseOtodomLead(
    { text: email.text, html: email.html, subject: email.subject, date: email.date },
    { defaultCountry: app.PHONE_DEFAULT_COUNTRY },
  );

  const hashes = hashIdentity(
    {
      email: lead.email,
      phone: lead.phone,
      firstName: lead.firstName,
      lastName: lead.lastName,
      country: app.PHONE_DEFAULT_COUNTRY,
    },
    { phoneCountry: app.PHONE_DEFAULT_COUNTRY },
  );

  const origin = (field: keyof typeof lead.sources): string =>
    lead.sources[field] ? (ORIGIN_LABEL[lead.sources[field] as string] ?? "") : "";

  const fields: NonNullable<ParseDiagnostics["fields"]> = [
    { label: "Imię i nazwisko", value: maskName(lead.fullName) ?? "—", origin: origin("fullName"), found: Boolean(lead.fullName) },
    { label: "Imię", value: maskName(lead.firstName) ?? "—", origin: origin("firstName"), found: Boolean(lead.firstName) },
    { label: "Nazwisko", value: maskName(lead.lastName) ?? "—", origin: origin("lastName"), found: Boolean(lead.lastName) },
    { label: "E-mail", value: maskEmail(lead.email) ?? "—", origin: origin("email"), found: Boolean(lead.email) },
    { label: "Telefon (E.164)", value: maskPhone(lead.phone) ?? "—", origin: origin("phone"), found: Boolean(lead.phone) },
    { label: "Numer ogłoszenia", value: lead.listingId ?? "—", origin: origin("listingId"), found: Boolean(lead.listingId) },
    { label: "URL ogłoszenia", value: lead.listingUrl ?? "—", origin: origin("listingUrl"), found: Boolean(lead.listingUrl) },
    { label: "Tytuł ogłoszenia", value: lead.listingTitle ?? "—", origin: origin("listingTitle"), found: Boolean(lead.listingTitle) },
    {
      label: "Treść wiadomości",
      value: lead.message ? `${lead.message.length} znaków` : "—",
      origin: lead.message ? "nie jest wysyłana do Meta" : "",
      found: Boolean(lead.message),
    },
  ];

  const base: ParseDiagnostics = {
    ok: true,
    message: {
      format: isMime ? "surowy MIME (mailparser)" : "sama treść",
      from: maskSender(email.from) ?? "—",
      subject: email.subject || "—",
      parts:
        [email.text ? "text/plain" : null, email.html ? "text/html" : null]
          .filter(Boolean)
          .join(" + ") || "—",
      date: email.date.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }),
    },
    filter: {
      accepted: filter.ok,
      reason: filter.reason,
      signals: filter.signals,
    },
    fields,
    missingFields: lead.missingFields,
  };

  if (!hasUsableIdentifier(hashes)) {
    return { ...base, verdict: "parse_failed" };
  }

  const event = buildLeadEvent({
    hashes,
    sentAt: lead.sentAt,
    messageId: email.messageId,
    listingId: lead.listingId,
    listingUrl: lead.listingUrl,
    listingTitle: lead.listingTitle,
  });

  const present = [
    hashes.emHash && "em",
    hashes.phHash && "ph",
    hashes.fnHash && "fn",
    hashes.lnHash && "ln",
    hashes.countryHash && "country",
  ].filter(Boolean) as string[];

  logger.info("dashboard.parser_run", {
    accepted: filter.ok,
    identifierCount: present.length,
    missingFields: lead.missingFields,
    emHash: maskHash(hashes.emHash),
  });

  return {
    ...base,
    verdict: filter.ok ? "sent" : "skipped",
    event: {
      eventId: event.event_id,
      eventSourceUrl: event.event_source_url ?? "—",
      listingId: event.custom_data.listing_id ?? "—",
      contentName: event.custom_data.content_name ?? "—",
      identifierCount: present.length,
      identifiers: present.join(", "),
      payload: JSON.stringify(buildRequestBody(event), null, 2),
    },
  };
}
