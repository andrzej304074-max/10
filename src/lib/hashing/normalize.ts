/**
 * Normalizacja danych przed haszowaniem — zgodnie z wymogami Meta dla
 * Advanced Matching / Conversions API.
 *
 * Reguły Meta (skrót):
 *  - wszystko trim + lowercase,
 *  - e-mail: pełny adres, bez spacji,
 *  - telefon: format E.164 BEZ znaku „+”, czyli same cyfry z kodem kraju,
 *  - imię/nazwisko: małe litery, bez interpunkcji i cyfr (znaki UTF-8 zostają,
 *    więc polskie znaki diakrytyczne zachowujemy),
 *  - kraj: dwuliterowy kod ISO 3166-1 alpha-2, małymi literami.
 */

/** Długości numerów krajowych bez kodu kraju — dla obsługiwanych krajów. */
const COUNTRY_DIALING: Record<string, { code: string; nationalLength: number[] }> = {
  PL: { code: "48", nationalLength: [9] },
  DE: { code: "49", nationalLength: [10, 11] },
  GB: { code: "44", nationalLength: [10] },
  CZ: { code: "420", nationalLength: [9] },
  SK: { code: "421", nationalLength: [9] },
  UA: { code: "380", nationalLength: [9] },
};

export function normalizeEmail(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  let value = raw.trim().toLowerCase();

  // Adres w formie "Jan Kowalski <jan@example.pl>" albo w nawiasach ostrych.
  const angle = value.match(/<([^>]+)>/);
  if (angle?.[1]) value = angle[1].trim();

  // mailto: oraz interpunkcja, w którą adres bywa owinięty w treści maila
  // (nawiasy, cudzysłowy, kropka na końcu zdania).
  value = value.replace(/^mailto:/, "");
  value = value.replace(/^[("'[{<]+/, "");
  value = value.replace(/[.,;:!?)\]}>"']+$/, "");
  value = value.replace(/\s+/g, "");

  if (!isPlausibleEmail(value)) return undefined;
  return value;
}

export function isPlausibleEmail(value: string): boolean {
  if (value.length < 6 || value.length > 254) return false;
  if ((value.match(/@/g) ?? []).length !== 1) return false;

  const atIndex = value.indexOf("@");
  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);

  if (local.length === 0 || domain.length < 3) return false;
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  if (domain.startsWith("-") || domain.endsWith("-")) return false;

  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld.length < 2 || !/^[a-z]+$/.test(tld)) return false;

  return /^[a-z0-9._%+'-]+$/.test(local) && /^[a-z0-9.-]+$/.test(domain);
}

export interface PhoneNormalizationResult {
  /** E.164 bez znaku „+”, np. „48123456789”. Undefined, gdy numer odrzucony. */
  value?: string;
  reason?:
    | "empty"
    | "too_short"
    | "too_long"
    | "not_a_number"
    | "looks_like_year_or_id";
}

/**
 * Sprowadza numer do E.164 bez „+”.
 *
 * Obsługiwane warianty wejścia (dla domyślnego kraju PL):
 *   "+48 123 456 789" → 48123456789
 *   "0048123456789"   → 48123456789
 *   "48-123-456-789"  → 48123456789
 *   "123 456 789"     → 48123456789   (numer krajowy, doklejamy kod kraju)
 *   "0123456789"      → 48123456789   (zero międzymiastowe obcinamy)
 */
export function normalizePhoneDetailed(
  raw: string | null | undefined,
  defaultCountry = "PL",
): PhoneNormalizationResult {
  if (!raw) return { reason: "empty" };

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { reason: "empty" };

  // Zapamiętujemy, czy numer był podany w formie międzynarodowej.
  const hadPlus = /^\s*(?:\+|00)/.test(trimmed);

  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return { reason: "not_a_number" };

  // Prefiks wyjścia międzynarodowego.
  if (hadPlus && digits.startsWith("00")) digits = digits.slice(2);

  const country = COUNTRY_DIALING[defaultCountry.toUpperCase()] ?? COUNTRY_DIALING.PL!;
  const { code, nationalLength } = country;

  // Numer krajowy z zerem międzymiastowym: 0 + 9 cyfr.
  if (!hadPlus && digits.startsWith("0") && nationalLength.includes(digits.length - 1)) {
    digits = digits.slice(1);
  }

  // Czysty numer krajowy — doklejamy kod kraju.
  if (nationalLength.includes(digits.length)) {
    digits = code + digits;
  }

  if (digits.length < 8) return { reason: "too_short" };
  if (digits.length > 15) return { reason: "too_long" };

  // Odsiewamy oczywiste pomyłki: rok, kod pocztowy, identyfikator ogłoszenia.
  if (digits.length < 9 && !hadPlus) return { reason: "looks_like_year_or_id" };

  return { value: digits };
}

export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry = "PL",
): string | undefined {
  return normalizePhoneDetailed(raw, defaultCountry).value;
}

/**
 * Imię/nazwisko: trim, lowercase, bez interpunkcji, cyfr i tytułów.
 * Polskie znaki diakrytyczne zostają — Meta oczekuje UTF-8, a ich strona
 * i tak wykonuje własne dopasowanie miękkie.
 */
export function normalizeName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  const value = raw
    .normalize("NFC")
    .trim()
    .toLowerCase()
    // interpunkcja, cyfry, symbole — poza łącznikiem i apostrofem w nazwiskach
    .replace(/[^\p{L}\p{M}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (value.length === 0) return undefined;
  return value;
}

/** Rozbicie „Jan Kowalski” na imię i nazwisko. */
export function splitFullName(raw: string | null | undefined): {
  firstName?: string;
  lastName?: string;
} {
  const normalized = normalizeName(raw);
  if (!normalized) return {};

  const HONORIFICS = new Set(["pan", "pani", "państwo", "panstwo", "mr", "mrs", "ms", "dr", "inż"]);
  const parts = normalized.split(" ").filter((part) => part.length > 0 && !HONORIFICS.has(part));

  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };

  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

export function normalizeCountry(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(value) ? value : undefined;
}
