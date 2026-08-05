import Link from "next/link";
import { cookies } from "next/headers";

import { DASHBOARD_COOKIE, verifySessionToken } from "@/lib/auth/dashboard";
import { ConfigError } from "@/lib/config/env";
import { getHealthSummary, listOpenDeadLetters, listRecentLeadEvents } from "@/lib/db/queries";
import type { DeadLetterRow, LeadEventRow } from "@/lib/db/schema";

import { loginAction, logoutAction, retryAction } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const dateFormatter = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Europe/Warsaw",
});

const STATUS_LABEL: Record<string, string> = {
  sent: "wysłane",
  pending: "oczekuje",
  failed_retryable: "do ponowienia",
  dead: "błąd trwały",
};

const RETRY_MESSAGE: Record<string, string> = {
  sent: "Zdarzenie zostało przyjęte przez Meta.",
  pending: "Zabrakło czasu funkcji — zdarzenie czeka, cron dokończy wysyłkę.",
  retry_scheduled: "Błąd przejściowy po stronie Meta — cron spróbuje ponownie.",
  dead: "Meta ponownie odrzuciła zdarzenie. Sprawdź kod i treść odpowiedzi.",
  already_sent: "To zdarzenie zostało już wcześniej wysłane.",
  not_found: "Nie znaleziono zdarzenia o podanym identyfikatorze.",
  no_payload: "Brak zapisanego payloadu — tego zdarzenia nie da się ponowić.",
  missing: "Nie wskazano zdarzenia do ponowienia.",
};

function formatDate(value: Date | null | undefined): string {
  return value ? dateFormatter.format(value) : "—";
}

function short(value: string | null | undefined, length = 12): string {
  if (!value) return "—";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

/* -------------------------------------------------------------- logowanie -- */

function LoginForm({ error }: { error: boolean }) {
  return (
    <main>
      <div className="login card">
        <h1 style={{ marginBottom: 16 }}>Panel leadów</h1>
        {error ? <div className="error">Nieprawidłowe hasło.</div> : null}
        <form action={loginAction}>
          <label htmlFor="password">Hasło do panelu</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <button className="primary" type="submit" style={{ marginTop: 14, width: "100%" }}>
            Zaloguj
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>
          Hasło pochodzi ze zmiennej środowiskowej <code>DASHBOARD_PASSWORD</code>.
        </p>
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------- tabele -- */

function LeadTable({ rows }: { rows: LeadEventRow[] }) {
  if (rows.length === 0) {
    return <p className="muted">Brak zdarzeń. Przy pierwszym leadzie pojawi się tu wpis.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Utworzono</th>
            <th>Status</th>
            <th>Kod Meta</th>
            <th>Próby</th>
            <th>Ogłoszenie</th>
            <th>event_id</th>
            <th>Hash e-mail</th>
            <th>Hash telefon</th>
            <th>Czas zdarzenia</th>
            <th>Tryb</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatDate(row.createdAt)}</td>
              <td>
                <span className={`badge badge-${row.status}`}>
                  {STATUS_LABEL[row.status] ?? row.status}
                </span>
              </td>
              <td>{row.metaResponseCode ?? "—"}</td>
              <td>{row.attempts}</td>
              <td>{row.listingId ?? "—"}</td>
              <td className="mono">{short(row.eventId, 16)}</td>
              {/* Dane osobowe wyłącznie jako skrót hasha — nigdy w postaci jawnej. */}
              <td className="mono">{short(row.emHash, 10)}</td>
              <td className="mono">{short(row.phHash, 10)}</td>
              <td>{formatDate(row.eventTime)}</td>
              <td>{row.testMode ? "test" : "prod"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeadLetterTable({ rows }: { rows: DeadLetterRow[] }) {
  if (rows.length === 0) {
    return <p className="muted">Dead-letter jest pusty.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Utworzono</th>
            <th>Powód</th>
            <th>Kod</th>
            <th>Próby</th>
            <th>event_id</th>
            <th>Odpowiedź Meta</th>
            <th>Akcja</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatDate(row.createdAt)}</td>
              <td>{row.reason ?? "—"}</td>
              <td>{row.errorCode ?? "—"}</td>
              <td>{row.attempts}</td>
              <td className="mono">{short(row.eventId, 16)}</td>
              <td
                className="mono"
                style={{ whiteSpace: "normal", maxWidth: 380 }}
                title={row.errorBody ?? undefined}
              >
                {short(row.errorBody, 120)}
              </td>
              <td>
                <form action={retryAction} className="inline">
                  <input type="hidden" name="eventId" value={row.eventId} />
                  <button type="submit">Wyślij ponownie</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- strona -- */

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; retry?: string }>;
}) {
  const params = await searchParams;

  let authorized: boolean;
  try {
    const store = await cookies();
    authorized = verifySessionToken(store.get(DASHBOARD_COOKIE)?.value);
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

  if (!authorized) return <LoginForm error={params.error === "1"} />;

  let leads: LeadEventRow[] = [];
  let deadLetters: DeadLetterRow[] = [];
  let summary: Awaited<ReturnType<typeof getHealthSummary>> | undefined;
  let dbError: string | undefined;

  try {
    [leads, deadLetters, summary] = await Promise.all([
      listRecentLeadEvents(100),
      listOpenDeadLetters(50),
      getHealthSummary(24),
    ]);
  } catch (error) {
    dbError =
      error instanceof ConfigError
        ? error.message
        : "Nie udało się połączyć z bazą danych. Sprawdź zmienną POSTGRES_URL i czy migracje zostały uruchomione.";
  }

  const retryNotice = params.retry ? (RETRY_MESSAGE[params.retry] ?? `Wynik: ${params.retry}`) : undefined;

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>Panel leadów</h1>
          <p className="muted" style={{ margin: 0 }}>
            Ostatnie 100 zdarzeń wysłanych do Meta Conversions API.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/dashboard/parser">
            <button type="button">Podgląd parsera</button>
          </Link>
          <form action={logoutAction}>
            <button type="submit">Wyloguj</button>
          </form>
        </div>
      </div>

      {retryNotice ? <div className="notice" style={{ marginTop: 20 }}>{retryNotice}</div> : null}
      {dbError ? (
        <div className="error" style={{ marginTop: 20, whiteSpace: "pre-wrap" }}>
          {dbError}
        </div>
      ) : null}

      {summary ? (
        <div className="stats">
          <div className="stat">
            <div className="muted">Wysłane (24 h)</div>
            <div className="value">{summary.events.sent ?? 0}</div>
          </div>
          <div className="stat">
            <div className="muted">Oczekujące</div>
            <div className="value">
              {(summary.events.pending ?? 0) + (summary.events.failed_retryable ?? 0)}
            </div>
          </div>
          <div className="stat">
            <div className="muted">Błędy trwałe</div>
            <div className="value">{summary.events.dead ?? 0}</div>
          </div>
          <div className="stat">
            <div className="muted">Maile odrzucone</div>
            <div className="value">{summary.emails.skipped ?? 0}</div>
          </div>
          <div className="stat">
            <div className="muted">Dead-letter (otwarte)</div>
            <div className="value">{summary.openDeadLetters}</div>
          </div>
          <div className="stat">
            <div className="muted">Ostatnie zdarzenie</div>
            <div className="value" style={{ fontSize: "0.95rem" }}>
              {summary.lastEventAt ? formatDate(new Date(summary.lastEventAt)) : "—"}
            </div>
          </div>
        </div>
      ) : null}

      <h2>Zdarzenia</h2>
      <LeadTable rows={leads} />

      <h2>Dead-letter</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        Zdarzenia odrzucone przez Meta na stałe (4xx) albo po wyczerpaniu prób. Ponowna wysyłka
        korzysta z zapisanego payloadu, więc <code>event_id</code> pozostaje ten sam i Meta nie
        zaliczy konwersji dwa razy.
      </p>
      <DeadLetterTable rows={deadLetters} />
    </main>
  );
}
