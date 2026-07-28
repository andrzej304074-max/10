/**
 * Maskowanie danych na potrzeby logów i panelu.
 *
 * Do logów i do bazy (kolumna `from_masked`) trafiają wyłącznie wyniki tych
 * funkcji. Zasada: zachowujemy tyle, żeby dało się rozpoznać wpis przy
 * diagnozie, ale nie tyle, żeby dało się zidentyfikować osobę.
 */

export function maskEmail(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return "***";

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const head = local.slice(0, 1);

  return `${head}***@${domain}`;
}

export function maskPhone(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "***";

  return `${"*".repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}`;
}

export function maskName(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  return `${trimmed.slice(0, 1).toUpperCase()}***`;
}

/** Skrót hasha do korelowania wpisów w logach (8 znaków = wystarczy, nie odwraca). */
export function maskHash(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return `${value.slice(0, 8)}…`;
}

/** Nadawca w formie „j***@otodom.pl” albo „*** <j***@otodom.pl>”. */
export function maskSender(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const angle = value.match(/<([^>]+)>/);
  if (angle?.[1]) return maskEmail(angle[1]);

  return value.includes("@") ? maskEmail(value) : "***";
}

/**
 * Skraca dowolny tekst do bezpiecznej długości i usuwa znaki nowej linii.
 * Używane przy zapisie treści odpowiedzi Meta oraz tematów wiadomości.
 */
export function truncate(value: string | null | undefined, maxLength = 500): string | undefined {
  if (value === null || value === undefined) return undefined;

  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;

  return `${flat.slice(0, maxLength)}…`;
}
