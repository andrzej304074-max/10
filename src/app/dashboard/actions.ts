"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  DASHBOARD_COOKIE,
  DASHBOARD_COOKIE_OPTIONS,
  createSessionToken,
  verifyDashboardPassword,
  verifySessionToken,
} from "@/lib/auth/dashboard";
import { getDashboardConfig } from "@/lib/config/env";
import { logger } from "@/lib/logger";
import { retryLeadEvent } from "@/lib/pipeline/deliver";
import { TimeBudget } from "@/lib/time-budget";

/**
 * Logowanie do panelu.
 *
 * Nieudana próba kończy się stałym opóźnieniem. To nie zastępuje prawdziwego
 * rate-limitingu (w środowisku serverless nie ma gdzie trzymać licznika bez
 * dodatkowego magazynu), ale wystarczająco spowalnia zgadywanie hasła.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");

  if (!verifyDashboardPassword(password)) {
    logger.warn("dashboard.login_failed");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    redirect("/dashboard?error=1");
  }

  const { DASHBOARD_SESSION_HOURS } = getDashboardConfig();
  const store = await cookies();

  store.set(DASHBOARD_COOKIE, createSessionToken(), {
    ...DASHBOARD_COOKIE_OPTIONS,
    maxAge: DASHBOARD_SESSION_HOURS * 3600,
  });

  logger.info("dashboard.login_ok");
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(DASHBOARD_COOKIE);
  redirect("/dashboard");
}

/** Ponowna wysyłka zdarzenia z dead-letter. */
export async function retryAction(formData: FormData): Promise<void> {
  const store = await cookies();
  if (!verifySessionToken(store.get(DASHBOARD_COOKIE)?.value)) {
    redirect("/dashboard");
  }

  const eventId = String(formData.get("eventId") ?? "");
  if (!eventId) redirect("/dashboard?retry=missing");

  const budget = new TimeBudget(50_000, 5_000);
  const result = await retryLeadEvent(eventId, { budget });

  logger.info("dashboard.retry", { eventId, outcome: result.outcome });

  revalidatePath("/dashboard");
  redirect(`/dashboard?retry=${result.outcome}`);
}
