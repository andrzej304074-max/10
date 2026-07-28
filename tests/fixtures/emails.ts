import type { NormalizedInboundEmail } from "@/lib/mail/types";

/**
 * Przykładowe wiadomości.
 *
 * Wszystkie dane osobowe są zmyślone. Układ pól odwzorowuje typowe powiadomienia
 * z formularza kontaktowego Otodom: wersję tekstową, wersję HTML zbudowaną na
 * tabeli, wariant przekazany (forward) oraz wiadomości niepełne.
 */

const BASE: Pick<NormalizedInboundEmail, "source" | "provider" | "to"> = {
  source: "webhook",
  provider: "resend",
  to: ["leady@moja-domena.pl"],
};

export const SENT_AT = new Date("2026-03-12T09:41:17.000Z");

/** Klasyczne powiadomienie w wersji tekstowej. */
export const plainTextLead: NormalizedInboundEmail = {
  ...BASE,
  messageId: "<abc123.plain@otodom.pl>",
  from: "Otodom <powiadomienia@otodom.pl>",
  subject: "Nowa wiadomość dotycząca Twojego ogłoszenia",
  date: SENT_AT,
  headers: { from: "powiadomienia@otodom.pl", "message-id": "<abc123.plain@otodom.pl>" },
  text: [
    "Nowa wiadomość dotycząca Twojego ogłoszenia",
    "",
    "Otrzymałeś nową wiadomość od osoby zainteresowanej Twoim ogłoszeniem.",
    "",
    "Imię i nazwisko: Anna Kowalska",
    "E-mail: anna.kowalska@example.pl",
    "Telefon: +48 601 234 567",
    "",
    "Treść wiadomości:",
    "Dzień dobry, jestem zainteresowana wynajmem hali.",
    "Proszę o kontakt telefoniczny w godzinach popołudniowych.",
    "",
    "Ogłoszenie: Hala produkcyjno-magazynowa 1200 m2, Kraków Nowa Huta",
    "Numer ogłoszenia: 64821573",
    "Zobacz ogłoszenie: https://www.otodom.pl/pl/oferta/hala-produkcyjno-magazynowa-krakow-ID4xK9p?utm_source=email&utm_medium=notification",
    "",
    "--",
    "Wiadomość wysłana przez serwis Otodom.pl",
  ].join("\n"),
};

/** Wersja HTML zbudowana na tabeli — etykieta i wartość w osobnych komórkach. */
export const htmlTableLead: NormalizedInboundEmail = {
  ...BASE,
  messageId: "<def456.html@otodom.pl>",
  from: "Otodom <noreply@mailing.otodom.pl>",
  subject: "Masz nową wiadomość od zainteresowanego",
  date: SENT_AT,
  headers: { from: "noreply@mailing.otodom.pl" },
  html: `<!DOCTYPE html>
<html><head><style>.x{color:red}</style></head>
<body>
  <table role="presentation" width="600">
    <tr><td colspan="2"><h2>Nowa wiadomo&#347;&#263; od u&#380;ytkownika</h2></td></tr>
    <tr><td>Imi&#281; i nazwisko:</td><td>Piotr Nowak</td></tr>
    <tr><td>E-mail:</td><td><a href="mailto:p.nowak@firma-transport.pl">p.nowak@firma-transport.pl</a></td></tr>
    <tr><td>Telefon:</td><td>601-234-568</td></tr>
    <tr><td>Wiadomo&#347;&#263;:</td><td>Prosz&#281; o informacj&#281; o dost&#281;pno&#347;ci hali od marca.</td></tr>
  </table>
  <p><a href="https://www.otodom.pl/pl/oferta/hala-magazynowa-krakow-ID4xK9p?utm_campaign=lead">Zobacz og&#322;oszenie</a></p>
  <p style="font-size:11px">Wiadomo&#347;&#263; wys&#322;ana przez serwis Otodom.pl</p>
</body></html>`,
};

/**
 * Wiadomość przekazana regułą w panelu poczty — `From:` został podmieniony
 * na własny adres, więc rozpoznanie musi oprzeć się na temacie i treści.
 */
export const forwardedLead: NormalizedInboundEmail = {
  ...BASE,
  messageId: "<ghi789.fwd@gmail.com>",
  from: "Moja Firma <biuro@moja-domena.pl>",
  subject: "Fwd: Nowa wiadomość dotycząca Twojego ogłoszenia",
  date: SENT_AT,
  headers: { from: "biuro@moja-domena.pl" },
  text: [
    "---------- Wiadomość przekazana dalej ----------",
    "Od: Otodom <powiadomienia@otodom.pl>",
    "",
    "Imię i nazwisko: Maria Wiśniewska-Zając",
    "E-mail: MARIA.WISNIEWSKA@Example.COM ",
    "Telefon: 512 900 100",
    "",
    "Treść wiadomości:",
    "Poproszę o metraż i cenę za metr.",
    "",
    "Zobacz ogłoszenie: https://www.otodom.pl/pl/oferta/hala-krakow-ID7zQ2m",
  ].join("\n"),
};

/** Lead bez numeru telefonu — e-mail jako jedyny identyfikator. */
export const leadWithoutPhone: NormalizedInboundEmail = {
  ...BASE,
  messageId: "<jkl012.nophone@otodom.pl>",
  from: "powiadomienia@otodom.pl",
  subject: "Zapytanie o ogłoszenie",
  date: SENT_AT,
  headers: { from: "powiadomienia@otodom.pl" },
  text: [
    "Nowa wiadomość dotycząca Twojego ogłoszenia",
    "",
    "Imię i nazwisko: Tomasz Zieliński",
    "E-mail: t.zielinski@logistyka-krakow.pl",
    "Telefon: -",
    "",
    "Treść wiadomości:",
    "Czy hala ma rampę przeładunkową?",
    "",
    "https://www.otodom.pl/pl/oferta/hala-krakow-ID7zQ2m",
  ].join("\n"),
};

/** Lead bez adresu e-mail — identyfikatorem jest telefon. */
export const leadWithoutEmail: NormalizedInboundEmail = {
  ...BASE,
  messageId: "<mno345.nomail@otodom.pl>",
  from: "powiadomienia@otodom.pl",
  subject: "Nowa wiadomość dotycząca Twojego ogłoszenia",
  date: SENT_AT,
  headers: { from: "powiadomienia@otodom.pl" },
  text: [
    "Nowa wiadomość dotycząca Twojego ogłoszenia",
    "",
    "Imię i nazwisko: Krzysztof Mazur",
    "Telefon: 0048 502 111 222",
    "",
    "Treść wiadomości:",
    "Proszę o kontakt.",
    "",
    "https://www.otodom.pl/pl/oferta/hala-krakow-ID7zQ2m",
  ].join("\n"),
};

/** Zwykły newsletter — musi zostać odrzucony przez filtr. */
export const unrelatedNewsletter: NormalizedInboundEmail = {
  ...BASE,
  messageId: "<pqr678.news@example.com>",
  from: "Newsletter <newsletter@example.com>",
  subject: "Promocja tygodnia — sprawdź nasze oferty",
  date: SENT_AT,
  headers: { from: "newsletter@example.com" },
  text: "Zobacz nasze najnowsze produkty w promocyjnych cenach. Kliknij tutaj: https://example.com/promo",
};

/** Wiadomość z Otodomu, ale niebędąca leadem (np. przypomnienie o płatności). */
export const otodomNonLead: NormalizedInboundEmail = {
  ...BASE,
  messageId: "<stu901.invoice@otodom.pl>",
  from: "faktury@otodom.pl",
  subject: "Faktura za usługi",
  date: SENT_AT,
  headers: { from: "faktury@otodom.pl" },
  text: "W załączniku przesyłamy fakturę za usługi promowania ogłoszeń.",
};
