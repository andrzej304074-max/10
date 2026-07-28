/** Wspólna reprezentacja wiadomości — niezależna od tego, skąd przyszła. */
export interface NormalizedInboundEmail {
  /** Message-ID z nagłówków; gdy go brak — deterministyczny zamiennik. */
  messageId: string;
  /** Pełny nagłówek From (może zawierać nazwę i adres). */
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Data wysłania (nagłówek Date) albo — w ostateczności — data odbioru. */
  date: Date;
  /** Nagłówki w postaci mapy z kluczami pisanymi małymi literami. */
  headers: Record<string, string>;
  source: "webhook" | "imap" | "manual";
  /** resend | mailgun | imap | manual */
  provider: string;
}

/** Czy Message-ID został wygenerowany przez nas (brak nagłówka w wiadomości). */
export const SYNTHETIC_MESSAGE_ID_PREFIX = "synthetic-";
