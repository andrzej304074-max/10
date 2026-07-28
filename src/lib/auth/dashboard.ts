import { createHmac } from "node:crypto";

import { getDashboardConfig } from "@/lib/config/env";

import { timingSafeCompare } from "./secret";

export const DASHBOARD_COOKIE = "otodom_capi_session";

/**
 * Token sesji: `<wygasa>.<HMAC>`.
 *
 * Kluczem HMAC jest samo hasło do panelu — dzięki temu zmiana hasła
 * unieważnia wszystkie wydane wcześniej sesje, bez żadnej tabeli sesji
 * (a tej w środowisku serverless wolimy nie utrzymywać).
 */
function sign(expiresAt: number, password: string): string {
  return createHmac("sha256", password).update(`dashboard|${expiresAt}`).digest("hex");
}

export function createSessionToken(now = Date.now()): string {
  const { DASHBOARD_PASSWORD, DASHBOARD_SESSION_HOURS } = getDashboardConfig();
  const expiresAt = now + DASHBOARD_SESSION_HOURS * 3600 * 1000;
  return `${expiresAt}.${sign(expiresAt, DASHBOARD_PASSWORD)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;

  const separator = token.indexOf(".");
  if (separator <= 0) return false;

  const expiresAt = Number.parseInt(token.slice(0, separator), 10);
  const signature = token.slice(separator + 1);

  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const { DASHBOARD_PASSWORD } = getDashboardConfig();
  return timingSafeCompare(signature, sign(expiresAt, DASHBOARD_PASSWORD));
}

export function verifyDashboardPassword(candidate: string): boolean {
  const { DASHBOARD_PASSWORD } = getDashboardConfig();
  return timingSafeCompare(candidate, DASHBOARD_PASSWORD);
}

export const DASHBOARD_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;
