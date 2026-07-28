import { ImapFlow } from "imapflow";

import type { ImapConfig } from "@/lib/config/env";
import { logger, type Logger } from "@/lib/logger";
import type { TimeBudget } from "@/lib/time-budget";

import { parseRawEmail, syntheticMessageId } from "./parse-raw";
import type { NormalizedInboundEmail } from "./types";

export interface ImapFetchOptions {
  budget: TimeBudget;
  /**
   * Zwraca zbiór Message-ID, które już są w bazie. Dzięki temu pobieramy pełną
   * treść tylko dla wiadomości naprawdę nowych — koperty są dużo tańsze.
   */
  isKnown?: (messageIds: string[]) => Promise<Set<string>>;
  log?: Logger;
  /** Wstrzykiwane w testach. */
  clientFactory?: (config: ImapConfig) => ImapFlow;
}

export interface ImapFetchResult {
  messages: NormalizedInboundEmail[];
  /** Ile wiadomości znalazło się w oknie czasowym. */
  totalFound: number;
  /** Ile z nich było nowych. */
  newFound: number;
  /** Ile nowych zostało na następny przebieg crona. */
  backlog: number;
}

function createClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: config.IMAP_SECURE,
    auth: { user: config.IMAP_USER, pass: config.IMAP_PASSWORD },
    // WAŻNE: własne logowanie imapflow potrafi wypisać tematy i adresy —
    // czyli dane osobowe. Wyłączamy je bezwarunkowo.
    logger: false,
    // W środowisku serverless nie ma sensu czekać dłużej niż budżet funkcji.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableAutoIdle: true,
  });
}

/**
 * Ścieżka zapasowa: pobiera z IMAP wiadomości z ostatnich N godzin.
 *
 * Przebieg jest świadomie dwufazowy:
 *  1. koperty (tanie) → Message-ID → odsiew tego, co już w bazie,
 *  2. pełna treść (droga) tylko dla nowych, maksymalnie `IMAP_MAX_MESSAGES_PER_RUN`.
 *
 * Połączenie jest zamykane w `finally` — funkcja serverless nie może zostawić
 * po sobie otwartego gniazda.
 */
export async function fetchRecentEmails(
  config: ImapConfig,
  options: ImapFetchOptions,
): Promise<ImapFetchResult> {
  const log = options.log ?? logger;
  const client = (options.clientFactory ?? createClient)(config);

  const since = new Date(Date.now() - config.IMAP_LOOKBACK_HOURS * 3600 * 1000);
  const messages: NormalizedInboundEmail[] = [];

  let totalFound = 0;
  let newFound = 0;

  await client.connect();

  try {
    const lock = await client.getMailboxLock(config.IMAP_MAILBOX);

    try {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) {
        return { messages, totalFound: 0, newFound: 0, backlog: 0 };
      }

      totalFound = uids.length;

      /* --- faza 1: koperty ------------------------------------------------ */
      const envelopes: Array<{ uid: number; messageId: string; date: Date; subject: string }> = [];

      for await (const message of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        const envelope = message.envelope;
        const date = envelope?.date ?? new Date();
        const subject = envelope?.subject ?? "";
        const from = envelope?.from?.[0]?.address ?? "";

        envelopes.push({
          uid: message.uid,
          messageId:
            envelope?.messageId?.trim() || syntheticMessageId({ from, subject, date }),
          date,
          subject,
        });
      }

      // Najnowsze najpierw — jeśli jest zaległość, wolimy świeże leady.
      envelopes.sort((a, b) => b.date.getTime() - a.date.getTime());

      const known = options.isKnown
        ? await options.isKnown(envelopes.map((entry) => entry.messageId))
        : new Set<string>();

      const unseen = envelopes.filter((entry) => !known.has(entry.messageId));
      newFound = unseen.length;

      const selected = unseen.slice(0, config.IMAP_MAX_MESSAGES_PER_RUN);

      /* --- faza 2: pełna treść -------------------------------------------- */
      if (selected.length > 0) {
        for await (const message of client.fetch(
          selected.map((entry) => entry.uid),
          { uid: true, source: true },
          { uid: true },
        )) {
          // Budżet czasu pilnujemy w pętli — pojedyncza duża wiadomość
          // potrafi zjeść kilka sekund.
          if (!options.budget.hasAtLeast(5_000)) {
            log.warn("imap.budget_exhausted_during_fetch", {
              fetched: messages.length,
              selected: selected.length,
            });
            break;
          }

          if (!message.source) continue;

          const parsed = await parseRawEmail(message.source, {
            source: "imap",
            provider: "imap",
            fallbackDate: new Date(),
          });
          messages.push(parsed);
        }
      }

      const backlog = Math.max(0, newFound - messages.length);
      if (backlog > 0) {
        log.warn("imap.backlog", {
          totalFound,
          newFound,
          processedNow: messages.length,
          backlog,
          limit: config.IMAP_MAX_MESSAGES_PER_RUN,
        });
      }

      return { messages, totalFound, newFound, backlog };
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // Serwer mógł już zerwać połączenie — wtedy zamykamy gniazdo twardo.
      client.close();
    }
  }
}
