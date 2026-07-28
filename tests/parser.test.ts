import { describe, expect, it } from "vitest";

import { htmlToText } from "@/lib/parser/html-to-text";
import { parseOtodomLead } from "@/lib/parser/otodom";
import type { NormalizedInboundEmail } from "@/lib/mail/types";

import {
  forwardedLead,
  htmlTableLead,
  leadWithoutEmail,
  leadWithoutPhone,
  plainTextLead,
} from "./fixtures/emails";

function parse(email: NormalizedInboundEmail) {
  return parseOtodomLead({
    text: email.text,
    html: email.html,
    subject: email.subject,
    date: email.date,
  });
}

describe("parser — wersja tekstowa", () => {
  const lead = parse(plainTextLead);

  it("wyciąga imię i nazwisko", () => {
    expect(lead.fullName).toBe("Anna Kowalska");
    expect(lead.firstName).toBe("anna");
    expect(lead.lastName).toBe("kowalska");
  });

  it("wyciąga e-mail i telefon", () => {
    expect(lead.email).toBe("anna.kowalska@example.pl");
    expect(lead.phone).toBe("48601234567");
  });

  it("wyciąga treść wiadomości bez kolejnych etykiet", () => {
    expect(lead.message).toContain("Dzień dobry, jestem zainteresowana wynajmem hali.");
    expect(lead.message).toContain("Proszę o kontakt telefoniczny");
    expect(lead.message).not.toContain("Ogłoszenie:");
    expect(lead.message).not.toContain("Numer ogłoszenia");
  });

  it("wyciąga numer ogłoszenia z etykiety", () => {
    expect(lead.listingId).toBe("64821573");
  });

  it("wyciąga URL ogłoszenia i usuwa parametry śledzące", () => {
    expect(lead.listingUrl).toBe(
      "https://www.otodom.pl/pl/oferta/hala-produkcyjno-magazynowa-krakow-ID4xK9p",
    );
  });

  it("wyciąga tytuł ogłoszenia", () => {
    expect(lead.listingTitle).toContain("Hala produkcyjno-magazynowa 1200 m2");
  });

  it("nie zgłasza braków dla kompletnej wiadomości", () => {
    expect(lead.missingFields).toEqual([]);
  });

  it("zapamiętuje datę wysłania jako źródło event_time", () => {
    expect(lead.sentAt).toEqual(plainTextLead.date);
  });
});

describe("parser — wersja HTML zbudowana na tabeli", () => {
  const lead = parse(htmlTableLead);

  it("radzi sobie z etykietą i wartością w osobnych komórkach", () => {
    expect(lead.fullName).toBe("Piotr Nowak");
    expect(lead.firstName).toBe("piotr");
    expect(lead.lastName).toBe("nowak");
  });

  it("wyciąga e-mail ukryty w linku mailto:", () => {
    expect(lead.email).toBe("p.nowak@firma-transport.pl");
  });

  it("normalizuje telefon zapisany z myślnikami", () => {
    expect(lead.phone).toBe("48601234568");
  });

  it("wyciąga treść wiadomości", () => {
    expect(lead.message).toBe("Proszę o informację o dostępności hali od marca.");
  });

  it("wyciąga URL z atrybutu href i wyprowadza z niego numer ogłoszenia", () => {
    expect(lead.listingUrl).toBe(
      "https://www.otodom.pl/pl/oferta/hala-magazynowa-krakow-ID4xK9p",
    );
    expect(lead.listingId).toBe("4xK9p");
  });
});

describe("parser — wiadomość przekazana dalej", () => {
  const lead = parse(forwardedLead);

  it("nie bierze nagłówka 'Od:' przekazanej wiadomości za imię i nazwisko", () => {
    expect(lead.fullName).toBe("Maria Wiśniewska-Zając");
    expect(lead.firstName).toBe("maria");
    expect(lead.lastName).toBe("wiśniewska-zając");
  });

  it("normalizuje adres zapisany wielkimi literami", () => {
    expect(lead.email).toBe("maria.wisniewska@example.com");
  });

  it("nie bierze adresu portalu za adres leada", () => {
    expect(lead.email).not.toContain("otodom.pl");
  });

  it("wyciąga telefon i numer ogłoszenia z URL-a", () => {
    expect(lead.phone).toBe("48512900100");
    expect(lead.listingId).toBe("7zQ2m");
  });
});

describe("parser — wiadomości niepełne", () => {
  it("radzi sobie bez telefonu i zgłasza brak", () => {
    const lead = parse(leadWithoutPhone);
    expect(lead.email).toBe("t.zielinski@logistyka-krakow.pl");
    expect(lead.phone).toBeUndefined();
    expect(lead.missingFields).toContain("phone");
  });

  it("radzi sobie bez e-maila i zgłasza brak", () => {
    const lead = parse(leadWithoutEmail);
    expect(lead.email).toBeUndefined();
    expect(lead.phone).toBe("48502111222");
    expect(lead.missingFields).toContain("email");
  });

  it("gdy brak linku, korzysta z tematu jako nazwy ogłoszenia", () => {
    const lead = parseOtodomLead({
      text: "Imię i nazwisko: Jan Kowalski\nE-mail: jan@firma.pl",
      subject: "Nowa wiadomość dotycząca hali w Krakowie",
      date: new Date("2026-03-12T09:41:17.000Z"),
    });

    expect(lead.listingTitle).toBe("Nowa wiadomość dotycząca hali w Krakowie");
    expect(lead.listingUrl).toBeUndefined();
    expect(lead.missingFields).toContain("listingUrl");
    expect(lead.missingFields).toContain("listingId");
  });
});

describe("htmlToText", () => {
  it("zamienia komórki i wiersze tabeli na złamania linii", () => {
    const text = htmlToText("<table><tr><td>Telefon:</td><td>601234567</td></tr></table>");
    expect(text).toBe("Telefon:\n601234567");
  });

  it("zachowuje adres z atrybutu href", () => {
    const text = htmlToText('<a href="https://www.otodom.pl/oferta/x-ID1234">Zobacz</a>');
    expect(text).toContain("https://www.otodom.pl/oferta/x-ID1234");
    expect(text).toContain("Zobacz");
  });

  it("nie duplikuje adresu, gdy tekst linku jest adresem", () => {
    const text = htmlToText('<a href="https://example.pl/a">https://example.pl/a</a>');
    expect(text).toBe("https://example.pl/a");
  });

  it("usuwa style i skrypty razem z zawartością", () => {
    const text = htmlToText("<style>.a{color:red}</style><script>alert(1)</script><p>Treść</p>");
    expect(text).toBe("Treść");
  });

  it("dekoduje encje nazwane i liczbowe", () => {
    expect(htmlToText("<p>Imi&#281; i&nbsp;nazwisko &amp; wi&#x119;cej</p>")).toBe(
      "Imię i nazwisko & więcej",
    );
  });
});
