export const dynamic = "force-static";

/**
 * Strona główna jest celowo pusta i bez żadnych danych — to publiczny adres
 * wdrożenia. Wszystko, co istotne, siedzi za hasłem albo za sekretem.
 */
export default function HomePage() {
  return (
    <main>
      <h1>Otodom → Meta Conversions API</h1>
      <p className="muted">
        Usługa działa w tle. Zapytania z formularza kontaktowego Otodom trafiają tu mailem
        i są zamieniane na zdarzenia <code>Lead</code> w Meta.
      </p>

      <div className="card" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>Punkty wejścia</h2>
        <ul className="muted" style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            <code>POST /api/inbound/email</code> — webhook dostawcy poczty (podpis wymagany)
          </li>
          <li>
            <code>GET /api/cron/poll-imap</code> — ścieżka zapasowa (nagłówek <code>Authorization</code>)
          </li>
          <li>
            <code>GET /api/health</code> — stan bazy i podsumowanie z ostatniej doby
          </li>
          <li>
            <a href="/dashboard">/dashboard</a> — panel z ostatnimi leadami (hasło)
          </li>
        </ul>
      </div>
    </main>
  );
}
