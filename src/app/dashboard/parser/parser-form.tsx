"use client";

import { useActionState } from "react";

import { analyzeEmail, type ParseDiagnostics } from "./actions";

const VERDICT: Record<string, { label: string; badge: string; note: string }> = {
  sent: {
    label: "Poszłoby do Meta",
    badge: "badge-sent",
    note: "Filtr przepuścił wiadomość, a parser znalazł co najmniej jeden identyfikator.",
  },
  skipped: {
    label: "Zostałoby pominięte",
    badge: "badge-pending",
    note: "Filtr odrzucił wiadomość. Parser i tak pokazany niżej — do porównania.",
  },
  parse_failed: {
    label: "Brak identyfikatora",
    badge: "badge-dead",
    note: "Parser nie znalazł ani e-maila, ani telefonu. Meta odrzuciłaby takie zdarzenie, więc nie jest wysyłane.",
  },
};

export function ParserForm() {
  const [result, formAction, pending] = useActionState<ParseDiagnostics | null, FormData>(
    analyzeEmail,
    null,
  );

  return (
    <>
      <form action={formAction} className="card" style={{ marginTop: 20 }}>
        <label htmlFor="content" style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>
          Treść wiadomości
        </label>
        <p className="muted" style={{ marginTop: 0 }}>
          Wklej całą wiadomość z Otodomu. Najlepiej surowe źródło (Gmail: <strong>⋮ → Pokaż
          oryginał → Kopiuj do schowka</strong>), ale sama treść też się nada.
        </p>
        <textarea
          id="content"
          name="content"
          rows={10}
          required
          placeholder="Wklej tutaj…"
          style={{
            width: "100%",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: "0.82rem",
            padding: "10px 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            resize: "vertical",
          }}
        />
        <button className="primary" type="submit" disabled={pending} style={{ marginTop: 12 }}>
          {pending ? "Analizuję…" : "Sprawdź, co zobaczy parser"}
        </button>
      </form>

      {result?.error ? (
        <div className="error" style={{ marginTop: 20 }}>
          {result.error}
        </div>
      ) : null}

      {result?.ok ? (
        <>
          {result.verdict ? (
            <div className="card" style={{ marginTop: 20 }}>
              <span className={`badge ${VERDICT[result.verdict]?.badge ?? ""}`}>
                {VERDICT[result.verdict]?.label ?? result.verdict}
              </span>
              <p className="muted" style={{ margin: "10px 0 0" }}>
                {VERDICT[result.verdict]?.note}
              </p>
            </div>
          ) : null}

          <h2>Wiadomość</h2>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Format</th>
                  <td>{result.message?.format}</td>
                </tr>
                <tr>
                  <th>Nadawca</th>
                  <td>{result.message?.from}</td>
                </tr>
                <tr>
                  <th>Temat</th>
                  <td style={{ whiteSpace: "normal" }}>{result.message?.subject}</td>
                </tr>
                <tr>
                  <th>Części</th>
                  <td>{result.message?.parts}</td>
                </tr>
                <tr>
                  <th>Data</th>
                  <td>{result.message?.date}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2>Filtr</h2>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Decyzja</th>
                  <td>
                    {result.filter?.accepted ? (
                      <span className="badge badge-sent">przyjęta</span>
                    ) : (
                      <span className="badge badge-dead">odrzucona ({result.filter?.reason})</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Nadawca</th>
                  <td>{result.filter?.signals.sender ? "pasuje" : "nie pasuje"}</td>
                </tr>
                <tr>
                  <th>Temat</th>
                  <td>{result.filter?.signals.subject ? "pasuje" : "nie pasuje"}</td>
                </tr>
                <tr>
                  <th>Treść</th>
                  <td>{result.filter?.signals.body ? "zawiera znacznik Otodomu" : "brak znacznika"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2>Wyciągnięte pola</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pole</th>
                  <th>Wartość</th>
                  <th>Skąd</th>
                </tr>
              </thead>
              <tbody>
                {result.fields?.map((field) => (
                  <tr key={field.label}>
                    <td>{field.label}</td>
                    <td className={field.found ? undefined : "muted"}>{field.value}</td>
                    <td className="muted">{field.origin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Dane osobowe są zamaskowane — pokazujemy tylko tyle, żeby potwierdzić, że parser
            trafił we właściwe miejsce.
          </p>

          {result.missingFields && result.missingFields.length > 0 ? (
            <div className="notice" style={{ marginTop: 12 }}>
              <strong>Nie wyciągnięto:</strong> {result.missingFields.join(", ")}. Jeśli któreś
              z tych pól jest w mailu, trzeba dopisać jego etykietę w{" "}
              <code>src/lib/config/patterns.ts</code>.
            </div>
          ) : null}

          {result.event ? (
            <>
              <h2>Zdarzenie</h2>
              <div className="table-wrap">
                <table>
                  <tbody>
                    <tr>
                      <th>event_id</th>
                      <td className="mono">{result.event.eventId}</td>
                    </tr>
                    <tr>
                      <th>event_source_url</th>
                      <td style={{ whiteSpace: "normal" }}>{result.event.eventSourceUrl}</td>
                    </tr>
                    <tr>
                      <th>listing_id</th>
                      <td>{result.event.listingId}</td>
                    </tr>
                    <tr>
                      <th>content_name</th>
                      <td style={{ whiteSpace: "normal" }}>{result.event.contentName}</td>
                    </tr>
                    <tr>
                      <th>Identyfikatory</th>
                      <td>
                        {result.event.identifiers}{" "}
                        <span className="muted">
                          ({result.event.identifierCount}/5 — im więcej, tym lepsze dopasowanie)
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h2>Payload</h2>
              <p className="muted" style={{ marginTop: -4 }}>
                Dokładnie to poleciałoby do Meta. Same hashe, bez tokenu dostępu.
              </p>
              <div className="table-wrap">
                <pre
                  style={{
                    margin: 0,
                    padding: 14,
                    overflowX: "auto",
                    fontSize: "0.78rem",
                    lineHeight: 1.6,
                  }}
                >
                  {result.event.payload}
                </pre>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
