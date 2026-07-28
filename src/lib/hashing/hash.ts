import { createHash } from "node:crypto";

import { normalizeCountry, normalizeEmail, normalizeName, normalizePhone } from "./normalize";

/** SHA-256 w zapisie szesnastkowym (lowercase) — format wymagany przez Meta. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const HEX_64 = /^[a-f0-9]{64}$/i;

/** Czy wartość jest już gotowym hashem SHA-256 (Meta zabrania podwójnego haszowania). */
export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value);
}

/** Haszuje wartość, ale tylko jeśli nie jest już hashem. */
export function hashOnce(value: string): string {
  return isSha256Hex(value) ? value.toLowerCase() : sha256Hex(value);
}

/** Dane wejściowe w postaci surowej — tuż po sparsowaniu maila. */
export interface RawIdentity {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  country?: string;
}

/** `user_data` gotowe do wysłania: same hashe, każdy w tablicy (format Meta). */
export interface HashedUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  country?: string[];
}

/** Hashe w postaci płaskiej — do zapisu w bazie i do budowy `event_id`. */
export interface IdentityHashes {
  emHash?: string;
  phHash?: string;
  fnHash?: string;
  lnHash?: string;
  countryHash?: string;
}

/**
 * Normalizuje i haszuje dane osobowe.
 *
 * Wynik zawiera wyłącznie SHA-256 — funkcja jest jedynym miejscem, przez które
 * dane osobowe przechodzą w drodze do bazy i do Meta.
 */
export function hashIdentity(
  identity: RawIdentity,
  { phoneCountry = "PL" }: { phoneCountry?: string } = {},
): IdentityHashes {
  const email = normalizeEmail(identity.email);
  const phone = normalizePhone(identity.phone, phoneCountry);
  const firstName = normalizeName(identity.firstName);
  const lastName = normalizeName(identity.lastName);
  const country = normalizeCountry(identity.country);

  return {
    emHash: email ? hashOnce(email) : undefined,
    phHash: phone ? hashOnce(phone) : undefined,
    fnHash: firstName ? hashOnce(firstName) : undefined,
    lnHash: lastName ? hashOnce(lastName) : undefined,
    countryHash: country ? hashOnce(country) : undefined,
  };
}

/** Zamienia płaskie hashe na strukturę `user_data` oczekiwaną przez Meta. */
export function toUserData(hashes: IdentityHashes): HashedUserData {
  const userData: HashedUserData = {};
  if (hashes.emHash) userData.em = [hashes.emHash];
  if (hashes.phHash) userData.ph = [hashes.phHash];
  if (hashes.fnHash) userData.fn = [hashes.fnHash];
  if (hashes.lnHash) userData.ln = [hashes.lnHash];
  if (hashes.countryHash) userData.country = [hashes.countryHash];
  return userData;
}

/**
 * Meta odrzuca zdarzenie bez żadnego identyfikatora użytkownika. Sprawdzamy to
 * po naszej stronie, żeby nie marnować prób i nie zaśmiecać dead-letter.
 */
export function hasUsableIdentifier(hashes: IdentityHashes): boolean {
  return Boolean(hashes.emHash || hashes.phHash);
}
