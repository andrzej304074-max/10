import { describe, expect, it } from "vitest";

import { shouldProcessEmail } from "@/lib/mail/filter";
import type { NormalizedInboundEmail } from "@/lib/mail/types";

import {
  forwardedLead,
  htmlTableLead,
  otodomNonLead,
  plainTextLead,
  unrelatedNewsletter,
} from "./fixtures/emails";

function email(overrides: Partial<NormalizedInboundEmail>): NormalizedInboundEmail {
  return {
    messageId: "<x@y>",
    from: "ktos@example.com",
    to: [],
    subject: "",
    date: new Date(),
    headers: {},
    source: "webhook",
    provider: "resend",
    ...overrides,
  };
}

describe("shouldProcessEmail", () => {
  it("przyjmuje powiadomienie z domeny Otodom", () => {
    const result = shouldProcessEmail(plainTextLead);
    expect(result.ok).toBe(true);
    expect(result.signals).toEqual({ sender: true, subject: true, body: true });
  });

  it("przyjmuje wersję HTML z subdomeny mailing.otodom.pl", () => {
    expect(shouldProcessEmail(htmlTableLead).ok).toBe(true);
  });

  it("przyjmuje wiadomość przekazaną, w której From został podmieniony", () => {
    const result = shouldProcessEmail(forwardedLead);
    expect(result.ok).toBe(true);
    // Nadawca się nie zgadza — decydują temat i znacznik w treści.
    expect(result.signals.sender).toBe(false);
    expect(result.signals.subject).toBe(true);
    expect(result.signals.body).toBe(true);
  });

  it("odrzuca newsletter spoza Otodomu", () => {
    const result = shouldProcessEmail(unrelatedNewsletter);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_from_otodom");
  });

  it("odrzuca wiadomość z Otodomu, która nie jest leadem", () => {
    const result = shouldProcessEmail(otodomNonLead);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("subject_not_matching");
  });

  it("odrzuca wiadomość z pustą treścią", () => {
    const result = shouldProcessEmail(
      email({
        from: "powiadomienia@otodom.pl",
        subject: "Nowa wiadomość dotycząca ogłoszenia",
        text: "   ",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty_body");
  });

  it("rozpoznaje nadawcę ukrytego w nagłówku Reply-To", () => {
    const result = shouldProcessEmail(
      email({
        from: "przekazywanie@moja-domena.pl",
        headers: { "reply-to": "powiadomienia@otodom.pl" },
        subject: "Nowa wiadomość",
        text: "Imię i nazwisko: Jan Kowalski",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.signals.sender).toBe(true);
  });

  it("rozpoznaje nadawcę ukrytego w nagłówku X-Original-From", () => {
    const result = shouldProcessEmail(
      email({
        from: "przekazywanie@moja-domena.pl",
        headers: { "x-original-from": "Otodom <noreply@otodom.pl>" },
        subject: "Zapytanie o ogłoszenie",
        text: "Imię i nazwisko: Jan Kowalski",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("nie daje się nabrać na domenę zawierającą nazwę portalu", () => {
    const result = shouldProcessEmail(
      email({
        from: "spam@otodom.pl.zlodziej.example",
        subject: "Nowa wiadomość dotycząca ogłoszenia",
        text: "Kliknij tutaj po nagrodę.",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.signals.sender).toBe(false);
  });

  it("czyta treść również z wersji HTML", () => {
    const result = shouldProcessEmail(
      email({
        from: "przekazywanie@moja-domena.pl",
        subject: "Fwd: Nowa wiadomość",
        html: '<p>Zobacz na <a href="https://www.otodom.pl/oferta/x-ID1">Otodom</a></p>',
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.signals.body).toBe(true);
  });
});
