import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Porównanie odporne na atak czasowy.
 *
 * Oba wejścia najpierw haszujemy, żeby porównywać bufory równej długości —
 * `timingSafeEqual` rzuca wyjątkiem przy różnych długościach, a sama różnica
 * długości też jest informacją, której nie chcemy ujawniać.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Sprawdza nagłówek `Authorization: Bearer <secret>`.
 *
 * Tak właśnie Vercel Cron uwierzytelnia wywołania: gdy w projekcie ustawiona
 * jest zmienna `CRON_SECRET`, platforma dokłada ten nagłówek automatycznie.
 */
export function hasValidBearer(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization");
  if (!header) return false;

  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) return false;

  return timingSafeCompare(token, secret);
}
