/**
 * Minimalny logger strukturalny (JSON w jednej linii — tak Vercel najlepiej
 * indeksuje logi).
 *
 * ZASADA BEZPIECZEŃSTWA: do loggera NIGDY nie trafiają surowe dane osobowe ani
 * sekrety. Wszystko, co pochodzi od użytkownika, musi wcześniej przejść przez
 * funkcje z `@/lib/hashing/mask`. Dodatkowo `redact()` poniżej wycina znane
 * wzorce sekretów, gdyby coś przypadkiem przeciekło do treści błędu.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function activeLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/** Klucze, których wartości nigdy nie pojawiają się w logach w jawnej postaci. */
const SENSITIVE_KEYS =
  /^(access_?token|token|password|passwd|secret|authorization|api_?key|signature|cookie|em|ph|fn|ln)$/i;

/** Wzorce sekretów wycinane z dowolnego stringa (np. z treści błędu HTTP). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/access_token=[^&\s"']+/gi, "access_token=***"],
  [/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"***"'],
  [/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer ***"],
];

export function redact(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[głęboko zagnieżdżone]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.test(key) ? "***" : sanitize(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;

  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...(sanitize(fields ?? {}) as LogFields),
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Logger z na stałe doklejonym kontekstem (np. messageId). Kontekst się kumuluje. */
  child(context: LogFields): Logger;
}

function createLogger(context: LogFields = {}): Logger {
  const withContext = (fields?: LogFields): LogFields => ({ ...context, ...fields });

  return {
    debug: (event, fields) => emit("debug", event, withContext(fields)),
    info: (event, fields) => emit("info", event, withContext(fields)),
    warn: (event, fields) => emit("warn", event, withContext(fields)),
    error: (event, fields) => emit("error", event, withContext(fields)),
    child: (nested) => createLogger({ ...context, ...nested }),
  };
}

export const logger: Logger = createLogger();
