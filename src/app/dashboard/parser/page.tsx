import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DASHBOARD_COOKIE, verifySessionToken } from "@/lib/auth/dashboard";
import { ConfigError } from "@/lib/config/env";

import { ParserForm } from "./parser-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Podgląd parsera — pozwala sprawdzić, co aplikacja wyciągnie z konkretnego
 * maila, bez terminala i bez wysyłania czegokolwiek do Meta.
 *
 * Ta sama ścieżka co produkcja, ale zakończona wyświetleniem wyniku zamiast
 * wysyłką. Przydaje się przy pierwszym uruchomieniu i za każdym razem, gdy
 * Otodom zmieni układ powiadomień.
 */
export default async function ParserPage() {
  try {
    const store = await cookies();
    if (!verifySessionToken(store.get(DASHBOARD_COOKIE)?.value)) {
      redirect("/dashboard");
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      return (
        <main>
          <h1>Panel niedostępny</h1>
          <div className="error" style={{ whiteSpace: "pre-wrap" }}>
            {error.message}
          </div>
        </main>
      );
    }
    throw error;
  }

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>Podgląd parsera</h1>
          <p className="muted" style={{ margin: 0 }}>
            Sprawdź, co aplikacja wyciągnie z konkretnej wiadomości. Nic nie zostaje wysłane
            ani zapisane.
          </p>
        </div>
        <Link href="/dashboard">
          <button type="button">← Wróć do panelu</button>
        </Link>
      </div>

      <ParserForm />
    </main>
  );
}
