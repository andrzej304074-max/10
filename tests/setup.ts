/**
 * Konfiguracja środowiska testowego.
 *
 * Zmienne ustawiamy PRZED importem modułów konfiguracji — `getXConfig()`
 * memoizuje wynik przy pierwszym odczycie, więc późniejsza podmiana
 * `process.env` nie miałaby już efektu.
 *
 * Wszystkie wartości są jawnie fikcyjne. Testy nigdy nie odzywają się
 * do prawdziwego Meta API ani do bazy — klienci HTTP i baza są wstrzykiwane.
 */

/** `whsec_` + base64 — format, jakiego oczekuje biblioteka svix. */
export const TEST_WEBHOOK_SECRET = `whsec_${Buffer.from(
  "testowy-sekret-webhooka-32-bajty!",
).toString("base64")}`;

export const TEST_CRON_SECRET = "testowy-cron-secret-0123456789abcdef";
export const TEST_DASHBOARD_PASSWORD = "testowe-haslo-panelu";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",

  META_ACCESS_TOKEN: "TESTOWY_TOKEN_NIE_JEST_PRAWDZIWY",
  META_DATASET_ID: "1062762802819993",
  META_API_VERSION: "v21.0",
  META_TEST_MODE: "false",

  POSTGRES_URL: "postgres://user:password@localhost:5432/test",

  INBOUND_PROVIDER: "resend",
  INBOUND_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  INBOUND_SIGNATURE_TOLERANCE_SECONDS: "300",

  CRON_SECRET: TEST_CRON_SECRET,
  DASHBOARD_PASSWORD: TEST_DASHBOARD_PASSWORD,

  DEFAULT_EVENT_SOURCE_URL: "https://www.otodom.pl/pl/oferta/domyslne-ogloszenie-IDdefault",
  DEFAULT_LISTING_ID: "unknown",
  DEFAULT_CONTENT_NAME: "Hala produkcyjno-magazynowa Kraków",
  PHONE_DEFAULT_COUNTRY: "PL",
  EVENT_ID_BUCKET_SECONDS: "300",

  META_MAX_ATTEMPTS: "5",
  META_TIMEOUT_MS: "10000",
  META_RETRY_BASE_MS: "500",
  META_RETRY_MAX_DELAY_MS: "8000",

  PENDING_MAX_ATTEMPTS: "15",
});
