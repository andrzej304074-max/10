import type { InboundProvider } from "@/lib/config/env";
import type { NormalizedInboundEmail } from "../types";

export interface InboundVerificationSuccess {
  ok: true;
  email: NormalizedInboundEmail;
}

export interface InboundVerificationFailure {
  ok: false;
  /** 401 dla problemów z podpisem, 400 dla niepoprawnego payloadu. */
  status: 400 | 401;
  /** Kod powodu — trafia do logu, nigdy do odpowiedzi HTTP w pełnej formie. */
  reason: string;
}

export type InboundVerificationResult = InboundVerificationSuccess | InboundVerificationFailure;

export interface InboundAdapter {
  name: InboundProvider;
  /**
   * Czyta ciało żądania i weryfikuje podpis.
   *
   * KOLEJNOŚĆ JEST OBOWIĄZKOWA: podpis sprawdzamy zanim cokolwiek zrobimy
   * z zawartością. Adapter zwraca znormalizowaną wiadomość dopiero po
   * pozytywnej weryfikacji.
   */
  readAndVerify(request: Request): Promise<InboundVerificationResult>;
}
