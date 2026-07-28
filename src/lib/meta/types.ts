import type { HashedUserData } from "@/lib/hashing/hash";

/** Zgodnie z dokumentacją Meta Conversions API dla zdarzeń bez pixela. */
export type MetaActionSource =
  | "email"
  | "website"
  | "phone_call"
  | "chat"
  | "physical_store"
  | "system_generated"
  | "app"
  | "business_messaging"
  | "other";

export interface MetaCustomData {
  lead_source: string;
  listing_id?: string;
  content_name?: string;
  [key: string]: unknown;
}

export interface MetaLeadEvent {
  event_name: string;
  /** Unix timestamp w sekundach. */
  event_time: number;
  /** Deterministyczny identyfikator — deduplikacja po stronie Meta. */
  event_id: string;
  action_source: MetaActionSource;
  event_source_url?: string;
  user_data: HashedUserData;
  custom_data: MetaCustomData;
}

/** Ciało żądania BEZ tokenu — token dokleja dopiero klient, tuż przed wysyłką. */
export interface MetaEventsRequestBody {
  data: MetaLeadEvent[];
  test_event_code?: string;
}

export interface MetaSuccessResponse {
  events_received?: number;
  messages?: unknown[];
  fbtrace_id?: string;
}

export interface MetaErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}
