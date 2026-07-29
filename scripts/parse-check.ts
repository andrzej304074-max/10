/**
 * Diagnostyka parsera — sprawdza, co aplikacja wyciągnie z konkretnego maila.
 *
 *   npm run parse:check -- sciezka/do/maila.eml
 *   npm run parse:check -- --reveal sciezka/do/maila.eml
 *   cat mail.eml | npm run parse:check
 *
 * Skrypt działa CAŁKOWICIE LOKALNIE: nie łączy się z bazą, nie wysyła niczego
 * do Meta i nie potrzebuje ani jednej zmiennej środowiskowej. Przechodzi
 * dokładnie tę samą ścieżkę co produkcja — filtr → parser → normalizacja →
 * haszowanie → budowa zdarzenia — więc pokazuje realny wynik, nie przybliżenie.
 *
 * Domyślnie dane osobowe są w wyniku ZAMASKOWANE, żeby wynik dało się
 * bezpiecznie komuś pokazać. Flaga `--reveal` odsłania pełne wartości —
 * używaj jej tylko na własnej maszynie, do weryfikacji poprawności.
 *
 * Wejście: plik .eml (surowy MIME), .txt albo .html. Format rozpoznawany jest
 * automatycznie.
 */
import { readFileSync } from "node:fs";

import { hashIdentity, hasUsableIdentifier } from "../src/lib/hashing/hash";
import { maskEmail, maskName, maskPhone, maskSender } from "../src/lib/hashing/mask";
import type { Logger } from "../src/lib/logger";
import { shouldProcessEmail } from "../src/lib/mail/filter";
import { parseRawEmail } from "../src/lib/mail/parse-raw";
import type { NormalizedInboundEmail } from "../src/lib/mail/types";
import { buildLeadEvent, buildRequestBody } from "../src/lib/meta/event";
import { parseOtodomLead } from "../src/lib/parser/otodom";
import type { ParsedLead } from "../src/lib/parser/types";

/** Kolory tylko na terminalu — przekierowany wynik ma zostać czystym tekstem. */
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ansi = (code: string): string => (COLOR ? `\u001b[${code}m` : "");

const RESET = ansi("0");
const BOLD = ansi("1");
const DIM = ansi("2");
const GREEN = ansi("32");
const RED = ansi("31");
const YELLOW = ansi("33");

/** Parser przyjmuje logger; tutaj nie chcemy żadnych logów obok raportu. */
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};

function heading(text: string): void {
  console.log(`\n${BOLD}── ${text} ${"─".repeat(Math.max(0, 58 - text.length))}${RESET}`);
}

function row(label: string, value: string, note = ""): void {
  const padded = label.padEnd(18, " ");
  console.log(`  ${padded} ${value}${note ? ` ${DIM}${note}${RESET}` : ""}`);
}

const MISSING = `${DIM}—${RESET}`;

async function readInput(): Promise<string> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--reveal");
  const path = args[0];

  if (path) return readFileSync(path, "utf8");

  if (process.stdin.isTTY) {
    console.error(
      "\nUżycie:\n" +
        "  npm run parse:check -- mail.eml\n" +
        "  npm run parse:check -- --reveal mail.eml\n" +
        "  cat mail.eml | npm run parse:check\n",
    );
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Czy wejście wygląda na surowy MIME (są nagłówki), czy na samą treść. */
function looksLikeMime(input: string): boolean {
  const head = input.slice(0, 2_000);
  return /^(?:From|To|Subject|Date|Message-ID|Received|MIME-Version|Content-Type):/im.test(head);
}

async function toEmail(input: string): Promise<NormalizedInboundEmail> {
  if (looksLikeMime(input)) {
    return parseRawEmail(input, { source: "manual", provider: "parse-check" });
  }

  // Sama treść bez nagłówków — nadawcę i temat podstawiamy tak, żeby filtr
  // nie przesłonił wyniku parsera. O filtrze i tak informujemy osobno.
  const isHtml = /<\s*(?:html|body|table|div|p|br)\b/i.test(input);

  return {
    messageId: "<parse-check@local>",
    from: "Otodom <powiadomienia@otodom.pl>",
    to: [],
    subject: "Nowa wiadomość dotycząca Twojego ogłoszenia",
    text: isHtml ? undefined : input,
    html: isHtml ? input : undefined,
    date: new Date(),
    headers: {},
    source: "manual",
    provider: "parse-check",
  };
}

function reportFilter(email: NormalizedInboundEmail): boolean {
  const filter = shouldProcessEmail(email);

  heading("FILTR");
  row(
    "decyzja",
    filter.ok ? `${GREEN}PRZYJĘTA${RESET}` : `${RED}ODRZUCONA${RESET} (${filter.reason})`,
  );
  row(
    "sygnały",
    [
      `nadawca=${filter.signals.sender ? "tak" : "nie"}`,
      `temat=${filter.signals.subject ? "tak" : "nie"}`,
      `treść=${filter.signals.body ? "tak" : "nie"}`,
    ].join("  "),
  );

  if (!filter.ok) {
    console.log(
      `\n  ${YELLOW}Ta wiadomość zostałaby pominięta.${RESET}\n` +
        `  ${DIM}Poszerz OTODOM_SENDER_DOMAINS / OTODOM_SUBJECT_PATTERNS albo wzorce\n` +
        `  w src/lib/config/patterns.ts. Poniżej i tak pokazuję wynik parsera.${RESET}`,
    );
  }

  return filter.ok;
}

function reportParser(lead: ParsedLead, reveal: boolean): void {
  const show = (value: string | undefined, mask: (v: string) => string | undefined): string => {
    if (!value) return MISSING;
    return reveal ? value : (mask(value) ?? MISSING);
  };

  const origin = (field: keyof ParsedLead["sources"]): string => {
    const source = lead.sources[field];
    if (!source) return "";
    return { label: "(z etykiety)", fallback: "(wzorzec awaryjny)", derived: "(wyprowadzone)" }[
      source
    ];
  };

  heading("PARSER");
  row("imię i nazwisko", show(lead.fullName, maskName), origin("fullName"));
  row("imię", show(lead.firstName, maskName), origin("firstName"));
  row("nazwisko", show(lead.lastName, maskName), origin("lastName"));
  row("e-mail", show(lead.email, maskEmail), origin("email"));
  row("telefon (E.164)", show(lead.phone, maskPhone), origin("phone"));
  row("numer ogłoszenia", lead.listingId ?? MISSING, origin("listingId"));
  row("URL ogłoszenia", lead.listingUrl ?? MISSING, origin("listingUrl"));
  row("tytuł ogłoszenia", lead.listingTitle ?? MISSING, origin("listingTitle"));
  row("data wysłania", lead.sentAt.toISOString());
  row(
    "treść wiadomości",
    lead.message ? `${DIM}${lead.message.length} znaków${RESET}` : MISSING,
    lead.message ? "(nie jest wysyłana do Meta)" : "",
  );

  if (lead.missingFields.length > 0) {
    console.log(
      `\n  ${YELLOW}Nie wyciągnięto:${RESET} ${lead.missingFields.join(", ")}\n` +
        `  ${DIM}Jeśli któreś z tych pól JEST w mailu, dopisz jego etykietę\n` +
        `  do odpowiedniej listy w src/lib/config/patterns.ts.${RESET}`,
    );
  }
}

async function main(): Promise<void> {
  const reveal = process.argv.includes("--reveal");
  const input = await readInput();

  if (input.trim().length === 0) {
    console.error("Puste wejście.");
    process.exit(1);
  }

  const email = await toEmail(input);

  heading("WIADOMOŚĆ");
  row("format", looksLikeMime(input) ? "surowy MIME (mailparser)" : "sama treść");
  row("Message-ID", email.messageId);
  row("nadawca", reveal ? email.from : (maskSender(email.from) ?? MISSING));
  row("temat", email.subject || MISSING);
  row(
    "części",
    [email.text ? "text/plain" : null, email.html ? "text/html" : null]
      .filter(Boolean)
      .join(" + ") || MISSING,
  );

  const passedFilter = reportFilter(email);

  const lead = parseOtodomLead(
    { text: email.text, html: email.html, subject: email.subject, date: email.date },
    // Log wyciszony — braki raportujemy niżej w czytelniejszej formie.
    { log: silentLogger },
  );

  reportParser(lead, reveal);

  /* --- haszowanie i zdarzenie ---------------------------------------------- */
  const hashes = hashIdentity({
    email: lead.email,
    phone: lead.phone,
    firstName: lead.firstName,
    lastName: lead.lastName,
    country: "PL",
  });

  heading("ZDARZENIE");

  if (!passedFilter) {
    console.log(
      `  ${YELLOW}Uwaga: filtr odrzucił tę wiadomość.${RESET} ` +
        `${DIM}Poniższe jest hipotetyczne —\n  zdarzenie NIE powstałoby.${RESET}\n`,
    );
  }

  if (!hasUsableIdentifier(hashes)) {
    console.log(
      `  ${RED}Brak identyfikatora (e-mail ani telefon).${RESET}\n` +
        `  ${DIM}Meta odrzuciłaby takie zdarzenie, więc aplikacja go nie wyśle —\n` +
        `  mail dostałby status parse_failed z powodem no_identifier.${RESET}`,
    );
  } else {
    const event = buildLeadEvent({
      hashes,
      sentAt: lead.sentAt,
      messageId: email.messageId,
      listingId: lead.listingId,
      listingUrl: lead.listingUrl,
      listingTitle: lead.listingTitle,
    });

    row("event_id", event.event_id);
    row("event_time", `${event.event_time} ${DIM}(${lead.sentAt.toISOString()})${RESET}`);
    row("action_source", event.action_source);
    row("event_source_url", event.event_source_url ?? MISSING);
    row(
      "identyfikatory",
      [
        hashes.emHash ? "em" : null,
        hashes.phHash ? "ph" : null,
        hashes.fnHash ? "fn" : null,
        hashes.lnHash ? "ln" : null,
        hashes.countryHash ? "country" : null,
      ]
        .filter(Boolean)
        .join(", "),
      `${
        [hashes.emHash, hashes.phHash, hashes.fnHash, hashes.lnHash, hashes.countryHash].filter(
          Boolean,
        ).length
      }/5 — im więcej, tym lepsze dopasowanie`,
    );

    heading("PAYLOAD (bez tokenu, same hashe)");
    console.log(JSON.stringify(buildRequestBody(event), null, 2));
  }

  console.log(
    `\n${DIM}${
      reveal
        ? "Dane odsłonięte (--reveal). Nie wklejaj tego wyniku nigdzie poza własną maszyną."
        : "Dane osobowe zamaskowane — ten wynik można bezpiecznie pokazać. Pełne wartości: --reveal"
    }${RESET}\n`,
  );

  process.exit(passedFilter ? 0 : 2);
}

main().catch((error: unknown) => {
  console.error("Błąd:", error);
  process.exit(1);
});
