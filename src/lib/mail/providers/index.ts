import { getInboundConfig, type InboundProvider } from "@/lib/config/env";

import { mailgunAdapter } from "./mailgun";
import { resendAdapter } from "./resend";
import type { InboundAdapter } from "./types";

const ADAPTERS: Record<InboundProvider, InboundAdapter> = {
  resend: resendAdapter,
  mailgun: mailgunAdapter,
};

/** Adapter wskazany zmienną `INBOUND_PROVIDER` (domyślnie: resend). */
export function getInboundAdapter(): InboundAdapter {
  const { INBOUND_PROVIDER } = getInboundConfig();
  return ADAPTERS[INBOUND_PROVIDER];
}

export { mailgunAdapter, resendAdapter };
export type { InboundAdapter, InboundVerificationResult } from "./types";
