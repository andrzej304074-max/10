/** Pola, których brak odnotowujemy w logu — bez podawania wartości. */
export type LeadField =
  | "fullName"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "message"
  | "listingId"
  | "listingUrl"
  | "listingTitle";

/** Wejście parsera — celowo niezależne od dostawcy poczty, żeby dało się testować. */
export interface LeadSourceDocument {
  /** Wersja text/plain wiadomości. */
  text?: string;
  /** Wersja text/html wiadomości. */
  html?: string;
  subject?: string;
  /** Data wysłania wiadomości (nagłówek Date lub czas odbioru). */
  date: Date;
}

/** Wynik parsowania — dane wciąż surowe, haszowanie jest krok dalej. */
export interface ParsedLead {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  message?: string;
  listingId?: string;
  listingUrl?: string;
  listingTitle?: string;
  /** Data wysłania — źródło `event_time`. */
  sentAt: Date;
  /** Pola, których nie udało się wyciągnąć. */
  missingFields: LeadField[];
  /** Skąd wzięło się dane pole — przydatne przy dostrajaniu wzorców. */
  sources: Partial<Record<LeadField, "label" | "fallback" | "derived">>;
}
