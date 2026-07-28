/**
 * Wzorce rozpoznawania i wyciągania danych z maili Otodom.
 *
 * Wszystko, co może wymagać dostrojenia po zobaczeniu prawdziwego maila,
 * mieszka w tym jednym pliku — reszta kodu tylko z niego korzysta.
 *
 * Każde pole ma listę wzorców próbowanych po kolei (od najbardziej do najmniej
 * konkretnego) plus wzorzec awaryjny (`fallback`), który szuka danych w całym
 * tekście bez oglądania się na etykiety. Gdy żaden wzorzec nie zadziała,
 * parser loguje `field=<nazwa> status=not_found` — bez wartości pola.
 *
 * Część list można nadpisać zmiennymi środowiskowymi (wartości rozdzielone
 * przecinkami). To NIE są sekrety — to reguły biznesowe.
 */

/* ------------------------------------------------------------- narzędzia -- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ozdobniki na początku linii: cytowanie, znaczniki list, resztki po tabelach. */
const LINE_PREFIX = "[\\t >*|\\u00b7\\u2022\\-]{0,8}";

/** Wartość mieszcząca się w jednej linii. */
const SINGLE_LINE_VALUE = "[^\\r\\n]{1,200}";

/**
 * Buduje wzorzec „etykieta: wartość”.
 *
 * Maile Otodom są zbudowane na tabelach HTML, więc po konwersji do tekstu
 * wartość bardzo często ląduje w kolejnej linii niż etykieta. Dlatego wzorzec
 * dopuszcza do dwóch złamań linii między dwukropkiem a wartością.
 *
 * @param labels    Warianty etykiety (PL i EN).
 * @param value     Wzorzec wartości (domyślnie: reszta linii).
 * @param anchored  Czy etykieta musi zaczynać linię (bezpieczniejsze —
 *                  krótkie etykiety typu „Od” bez tego łapią przypadkowy tekst).
 */
export function labelledPattern(
  labels: string[],
  { value = SINGLE_LINE_VALUE, anchored = true }: { value?: string; anchored?: boolean } = {},
): RegExp {
  const alternatives = labels.map(escapeRegExp).join("|");
  const prefix = anchored ? `(?:^|\\r?\\n)${LINE_PREFIX}` : "";
  return new RegExp(
    `${prefix}(?:${alternatives})[\\t ]*[:\\uff1a][\\t ]*(?:\\r?\\n[\\t ]*){0,2}(${value})`,
    "i",
  );
}

function fromEnvList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/* ------------------------------------------------------- reguły nadawcy -- */

const DEFAULT_SENDER_DOMAINS = [
  "otodom.pl",
  "mail.otodom.pl",
  "mailing.otodom.pl",
  "powiadomienia.otodom.pl",
  "olx.pl",
  "olxgroup.com",
  "grupaolx.pl",
];

/**
 * Domeny, z których akceptujemy wiadomości.
 * Nadpisanie: `OTODOM_SENDER_DOMAINS=otodom.pl,mojadomena.pl`
 */
export function allowedSenderDomains(): string[] {
  return fromEnvList("OTODOM_SENDER_DOMAINS") ?? DEFAULT_SENDER_DOMAINS;
}

/**
 * Nagłówki, w których szukamy oryginalnego nadawcy. Przekazywanie poczty
 * (forward) potrafi podmienić `From:` na Twój własny adres — wtedy prawdziwy
 * nadawca zostaje w jednym z pozostałych nagłówków.
 */
export const SENDER_HEADER_CANDIDATES = [
  "from",
  "reply-to",
  "return-path",
  "x-original-from",
  "x-original-sender",
  "x-forwarded-for",
  "sender",
  "x-env-sender",
];

/* --------------------------------------------------------- reguły tematu -- */

const DEFAULT_SUBJECT_PATTERNS: RegExp[] = [
  /nowa\s+wiadomo/i, // "Nowa wiadomość dotycząca ogłoszenia"
  /wiadomo(?:ść|sc)\s+(?:od|dotycz)/i,
  /zapytanie\s+(?:o|do|dotycz)/i,
  /masz\s+(?:now[aą]|wiadomo)/i,
  /otrzyma(?:łe|le)ś\s+wiadomo/i,
  /odpowied(?:ź|z)\s+na\s+og(?:ł|l)oszenie/i,
  /kontakt\s+(?:w\s+sprawie|do\s+og)/i,
  /otodom/i, // ostatnia deska ratunku — temat firmowany przez portal
  /new\s+(?:message|enquiry|inquiry|lead)/i,
];

/**
 * Wzorce tematu. Wystarczy, że pasuje jeden.
 * Nadpisanie: `OTODOM_SUBJECT_PATTERNS=nowa wiadomość,zapytanie` (fragmenty tekstu,
 * dopasowanie bez uwzględniania wielkości liter).
 */
export function subjectPatterns(): RegExp[] {
  const override = fromEnvList("OTODOM_SUBJECT_PATTERNS");
  if (!override) return DEFAULT_SUBJECT_PATTERNS;
  return override.map((fragment) => new RegExp(escapeRegExp(fragment), "i"));
}

/**
 * Znaczniki w treści, po których poznajemy maila z Otodom nawet wtedy, gdy
 * nadawca i temat zostały przemielone przez regułę przekazywania poczty.
 */
export const BODY_MARKERS: RegExp[] = [
  /otodom\.pl/i,
  /\botodom\b/i,
  /grupa\s+olx/i,
];

/* ------------------------------------------------------------ pola leada -- */

export interface FieldPatternSet {
  /** Wzorce etykietowe, próbowane po kolei. */
  labelled: RegExp[];
  /** Wzorzec awaryjny — szuka w całym tekście, gdy etykiety zawiodą. */
  fallback?: RegExp;
}

export const NAME_LABELS = [
  "Imię i nazwisko",
  "Imie i nazwisko",
  "Imię",
  "Imie",
  "Nazwa",
  "Nadawca",
  "Osoba kontaktowa",
  "Dane kontaktowe",
  "Od",
  "Kontakt od",
  "Zainteresowany",
  "Klient",
  "Full name",
  "Name",
  "Sender",
  "Contact",
];

export const EMAIL_LABELS = [
  "Adres e-mail",
  "Adres email",
  "E-mail",
  "Email",
  "Mail",
  "E-mail address",
  "Email address",
];

export const PHONE_LABELS = [
  "Numer telefonu",
  "Nr telefonu",
  "Nr tel",
  "Telefon kontaktowy",
  "Telefon",
  "Tel.",
  "Tel",
  "Komórka",
  "Phone number",
  "Phone",
  "Mobile",
];

export const MESSAGE_LABELS = [
  "Treść wiadomości",
  "Tresc wiadomosci",
  "Treść zapytania",
  "Wiadomość",
  "Wiadomosc",
  "Komentarz",
  "Zapytanie",
  "Message",
  "Enquiry",
  "Inquiry",
];

export const LISTING_ID_LABELS = [
  "Numer ogłoszenia",
  "Nr ogłoszenia",
  "Numer oferty",
  "Nr oferty",
  "ID ogłoszenia",
  "Identyfikator ogłoszenia",
  "Sygnatura",
  "Listing ID",
  "Offer ID",
  "Advert ID",
];

export const LISTING_TITLE_LABELS = [
  "Tytuł ogłoszenia",
  "Dotyczy ogłoszenia",
  "Ogłoszenie",
  "Oferta",
  "Nieruchomość",
  "Listing",
  "Property",
];

/** Ogólny adres e-mail — używany też do wyłuskiwania z tekstu. */
export const EMAIL_GENERIC = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/**
 * Ogólny numer telefonu. Świadomie luźny — walidację długości (9–15 cyfr)
 * robi normalizator, nie regex.
 */
export const PHONE_GENERIC = /(?:(?:\+|00)[\t ]?\d{1,3}[\t \-.]?)?(?:\d[\t \-.()]{0,2}){7,14}\d/g;

export const FIELD_PATTERNS: Record<
  "fullName" | "email" | "phone" | "listingId" | "listingTitle",
  FieldPatternSet
> = {
  fullName: {
    labelled: [
      labelledPattern(NAME_LABELS, { value: "[^\\r\\n]{2,120}" }),
      labelledPattern(NAME_LABELS, { value: "[^\\r\\n]{2,120}", anchored: false }),
    ],
  },
  email: {
    labelled: [
      labelledPattern(EMAIL_LABELS, { value: EMAIL_GENERIC.source }),
      labelledPattern(EMAIL_LABELS, { value: EMAIL_GENERIC.source, anchored: false }),
    ],
    fallback: EMAIL_GENERIC,
  },
  phone: {
    labelled: [
      labelledPattern(PHONE_LABELS, { value: "[+0-9][0-9 ()\\-.]{6,24}" }),
      labelledPattern(PHONE_LABELS, { value: "[+0-9][0-9 ()\\-.]{6,24}", anchored: false }),
    ],
    fallback: PHONE_GENERIC,
  },
  listingId: {
    labelled: [
      labelledPattern(LISTING_ID_LABELS, { value: "[A-Za-z0-9_-]{3,32}" }),
      labelledPattern(LISTING_ID_LABELS, { value: "[A-Za-z0-9_-]{3,32}", anchored: false }),
    ],
  },
  listingTitle: {
    labelled: [labelledPattern(LISTING_TITLE_LABELS, { value: "[^\\r\\n]{3,180}" })],
  },
};

/**
 * Treść wiadomości bywa wielolinijkowa, więc ma własny wzorzec z terminatorem
 * (kolejna etykieta, stopka albo koniec tekstu).
 */
export const MESSAGE_PATTERN = new RegExp(
  `(?:^|\\r?\\n)${LINE_PREFIX}(?:${MESSAGE_LABELS.map(escapeRegExp).join("|")})` +
    `[\\t ]*[:\\uff1a]?[\\t ]*(?:\\r?\\n)?([\\s\\S]{1,4000}?)` +
    `(?=\\r?\\n[\\t ]*(?:${[
      ...EMAIL_LABELS,
      ...PHONE_LABELS,
      ...NAME_LABELS,
      ...LISTING_ID_LABELS,
      ...LISTING_TITLE_LABELS,
      "Pozdrawiam",
      "Odpowiedz",
      "Zobacz ogłoszenie",
      "Ta wiadomość",
      "Otodom",
      "--",
    ]
      .map(escapeRegExp)
      .join("|")})|$)`,
  "i",
);

/* --------------------------------------------------------- link ogłoszenia -- */

/** Adres ogłoszenia w treści maila (HTML i plain text). */
export const LISTING_URL_PATTERNS: RegExp[] = [
  /https?:\/\/(?:www\.)?otodom\.pl\/[^\s"'<>)\]]+/gi,
  /https?:\/\/(?:www\.)?olx\.pl\/[^\s"'<>)\]]*oferta[^\s"'<>)\]]*/gi,
];

/**
 * Identyfikator ogłoszenia zaszyty w URL-u.
 * Otodom używa sufiksu `-IDxxxxx` w slugu oferty.
 */
export const LISTING_ID_FROM_URL_PATTERNS: RegExp[] = [
  /-ID([A-Za-z0-9]{4,16})(?:[/?#]|$)/,
  /[?&](?:id|offer_id|listing_id|adId)=([A-Za-z0-9]{4,16})\b/i,
  /\/oferta\/[^/?#]*?-([A-Za-z0-9]{6,16})(?:[/?#]|$)/,
];

/** Parametry śledzenia usuwane z `event_source_url`. */
export const TRACKING_QUERY_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "msclkid",
  "_ga",
  "mkt_tok",
];

/* ------------------------------------------- adresy odrzucane przy fallbacku -- */

const DEFAULT_EXCLUDED_EMAIL_DOMAINS = [
  "otodom.pl",
  "mail.otodom.pl",
  "mailing.otodom.pl",
  "powiadomienia.otodom.pl",
  "olx.pl",
  "olxgroup.com",
  "grupaolx.pl",
];

/**
 * Domeny, których adresy nie mogą zostać uznane za adres leada.
 * Dorzuć tu własny adres skrzynki, jeśli zdarza się w treści przekazanego maila:
 * `OTODOM_EXCLUDED_EMAIL_DOMAINS=otodom.pl,mojafirma.pl`
 */
export function excludedEmailDomains(): string[] {
  return fromEnvList("OTODOM_EXCLUDED_EMAIL_DOMAINS") ?? DEFAULT_EXCLUDED_EMAIL_DOMAINS;
}

/** Adresy techniczne — nigdy nie są adresem leada. */
export const EXCLUDED_EMAIL_LOCALPARTS =
  /^(no-?reply|no_reply|noreply|donotreply|do-not-reply|postmaster|mailer-daemon|bounce[s]?|notifications?|automat|support|info|biuro|kontakt)$/i;

/**
 * Wartości, które po dopasowaniu etykiety oznaczają „pole puste”.
 * Otodom potrafi wstawić kreskę zamiast pominąć wiersz.
 */
export const EMPTY_VALUE_MARKERS = [
  "-",
  "--",
  "—",
  "brak",
  "nie podano",
  "nie podał",
  "nie podała",
  "n/a",
  "na",
  "none",
  "not provided",
  "brak danych",
];

/**
 * Etykiety wykrywane w wyciągniętej wartości. Jeśli parser trafi na nie
 * w miejscu wartości, znaczy to, że pole było puste i złapaliśmy etykietę
 * następnego wiersza — wtedy wartość odrzucamy.
 */
export const ALL_LABELS = [
  ...NAME_LABELS,
  ...EMAIL_LABELS,
  ...PHONE_LABELS,
  ...MESSAGE_LABELS,
  ...LISTING_ID_LABELS,
  ...LISTING_TITLE_LABELS,
];
