import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { hasValidBearer } from "@/lib/auth/secret";
import { ConfigError, getAppConfig, getCronConfig, getMetaConfig } from "@/lib/config/env";
import { logger } from "@/lib/logger";
import type { NormalizedInboundEmail } from "@/lib/mail/types";
import { processInboundEmail } from "@/lib/pipeline/process-email";
import { TimeBudget } from "@/lib/time-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_DURATION_MS = maxDuration * 1000;

const bodySchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  fullName: z.string().optional(),
  message: z.string().optional(),
  listingId: z.string().optional(),
  listingUrl: z.string().url().optional(),
  listingTitle: z.string().optional(),
  /** Zbuduj payload i zwróć go, nie wysyłaj i nie zapisuj niczego w bazie. */
  dryRun: z.boolean().optional(),
  /**
   * Nadpisanie `action_source` — wyłącznie do diagnozy. Narzędzia podglądowe
   * Meta bywają zbudowane pod zdarzenia ze strony WWW, więc porównanie
   * `system_generated` z `website` potrafi rozstrzygnąć, czy zdarzenie
   * na pewno dociera, a tylko się nie wyświetla.
   */
  actionSource: z
    .enum([
      "email",
      "website",
      "phone_call",
      "chat",
      "physical_store",
      "system_generated",
      "app",
      "business_messaging",
      "other",
    ])
    .optional(),
});

/**
 * Składa wiadomość w formacie, jaki wysyła Otodom.
 *
 * Celowo przepuszczamy zdarzenie testowe przez PRAWDZIWY parser, a nie
 * budujemy payloadu na skróty. Dzięki temu ten endpoint sprawdza cały łańcuch:
 * filtr → parser → normalizacja → haszowanie → budowa zdarzenia → wysyłka.
 */
function buildSyntheticEmail(input: z.infer<typeof bodySchema>): NormalizedInboundEmail {
  const app = getAppConfig();
  const nonce = randomUUID();

  // Domyślnie losowy adres — dzięki temu kolejne wywołania testowe tworzą
  // osobne zdarzenia, zamiast wpadać w deduplikację po `event_id`.
  const email = input.email ?? `test-${nonce.slice(0, 8)}@example.org`;
  const phone = input.phone ?? "+48 123 456 789";
  const fullName = input.fullName ?? "Jan Testowy";
  const message = input.message ?? "To jest testowe zapytanie wygenerowane przez /api/dev/send-test-lead.";
  const listingUrl = input.listingUrl ?? app.DEFAULT_EVENT_SOURCE_URL;
  const listingTitle = input.listingTitle ?? app.DEFAULT_CONTENT_NAME;
  const listingIdLine = input.listingId ? `Numer ogłoszenia: ${input.listingId}\n` : "";

  const date = new Date();

  const text = [
    "Nowa wiadomość dotycząca Twojego ogłoszenia",
    "",
    `Imię i nazwisko: ${fullName}`,
    `E-mail: ${email}`,
    `Telefon: ${phone}`,
    "",
    "Treść wiadomości:",
    message,
    "",
    `Ogłoszenie: ${listingTitle}`,
    listingIdLine.trim(),
    `Zobacz ogłoszenie: ${listingUrl}`,
    "",
    "--",
    "Wiadomość wysłana przez serwis Otodom.pl",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    messageId: `<test-${nonce}@otodom-capi.local>`,
    from: "Otodom <noreply@otodom.pl>",
    to: [],
    subject: "Nowa wiadomość dotycząca Twojego ogłoszenia",
    text,
    date,
    headers: { from: "noreply@otodom.pl", date: date.toUTCString() },
    source: "manual",
    provider: "manual",
  };
}

/**
 * Wysyła jedno syntetyczne zdarzenie Lead.
 *
 * Uwierzytelnienie: `Authorization: Bearer $CRON_SECRET`.
 *
 * Tryb dry-run (`?dryRun=1` albo `{"dryRun": true}`) zwraca gotowy payload
 * i NIE dotyka ani Meta, ani bazy — payload nie zawiera tokenu dostępu,
 * bo ten dokleja dopiero klient HTTP tuż przed wysyłką.
 */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();

  let cronSecret: string;
  try {
    cronSecret = getCronConfig().CRON_SECRET;
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("dev.config_error", { group: error.group, issues: error.issues });
      return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 500 });
    }
    throw error;
  }

  if (!hasValidBearer(request, cronSecret)) {
    logger.warn("dev.unauthorized");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
      { status: 400 },
    );
  }

  const dryRun =
    parsed.data.dryRun === true || new URL(request.url).searchParams.get("dryRun") === "1";

  const email = buildSyntheticEmail(parsed.data);
  const budget = new TimeBudget(MAX_DURATION_MS - (Date.now() - startedAt), 5_000);

  try {
    const result = await processInboundEmail(email, {
      budget,
      dryRun,
      ...(parsed.data.actionSource
        ? { eventOptions: { actionSource: parsed.data.actionSource } }
        : {}),
    });
    const meta = getMetaConfig();

    logger.info("dev.test_lead", {
      dryRun,
      outcome: result.outcome,
      eventId: result.eventId,
      testMode: meta.META_TEST_MODE,
    });

    return NextResponse.json(
      {
        ok: true,
        dryRun,
        outcome: result.outcome,
        eventId: result.eventId,
        actionSource: parsed.data.actionSource ?? "system_generated",
        status: result.status,
        attempts: result.attempts,
        reason: result.reason,
        /** W trybie testowym Meta pokaże zdarzenie w zakładce „Testowanie zdarzeń”. */
        testMode: meta.META_TEST_MODE,
        testEventCode: meta.META_TEST_MODE ? meta.META_TEST_EVENT_CODE : undefined,
        payload: result.payload,
        durationMs: Date.now() - startedAt,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      return NextResponse.json(
        { ok: false, error: "misconfigured", group: error.group, issues: error.issues },
        { status: 500 },
      );
    }

    logger.error("dev.test_lead_failed", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown_error",
    });
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
