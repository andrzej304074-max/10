# Otodom → Meta Conversions API

Aplikacja Next.js (App Router, TypeScript) wdrażana na Vercel. Zamienia maile
z formularza kontaktowego Otodom na zdarzenia `Lead` w Meta Conversions API,
dzięki czemu kampanie na Facebooku i Instagramie mogą optymalizować się pod
realne zapytania — mimo że na otodom.pl nie da się zainstalować pixela.

---

## Spis treści

1. [Jak to działa](#jak-to-działa)
2. [Wymagania](#wymagania)
3. [Instalacja lokalna](#instalacja-lokalna)
4. [Zmienne środowiskowe](#zmienne-środowiskowe)
5. [Baza danych i migracje](#baza-danych-i-migracje)
6. [Konfiguracja poczty przychodzącej](#konfiguracja-poczty-przychodzącej)
7. [Cron — ścieżka zapasowa](#cron--ścieżka-zapasowa)
8. [Token systemowy Meta z uprawnieniem `ads_management`](#token-systemowy-meta-z-uprawnieniem-ads_management)
9. [Weryfikacja zdarzeń w Menedżerze zdarzeń](#weryfikacja-zdarzeń-w-menedżerze-zdarzeń)
10. [Niestandardowa konwersja oparta o zdarzenie Lead](#niestandardowa-konwersja-oparta-o-zdarzenie-lead)
11. [Panel `/dashboard`](#panel-dashboard)
12. [Ograniczenia jakości dopasowania](#ograniczenia-jakości-dopasowania)
13. [RODO](#rodo)
14. [Struktura projektu](#struktura-projektu)
15. [Testy](#testy)
16. [Dostrajanie parsera](#dostrajanie-parsera)
17. [Rozwiązywanie problemów](#rozwiązywanie-problemów)

---

## Jak to działa

```
Reklama FB/IG  →  ogłoszenie na Otodom  →  formularz kontaktowy
                                                  │
                                                  ▼
                                     mail na Twoją skrzynkę
                                                  │
                    ┌─────────────────────────────┴──────────────────────┐
                    ▼                                                    ▼
      ŚCIEŻKA GŁÓWNA: reguła przekazywania                ŚCIEŻKA ZAPASOWA: cron co 5 min
      → adres dostawcy inbound parse                      → odpytuje skrzynkę przez IMAP
      → POST /api/inbound/email                           → GET /api/cron/poll-imap
                    │                                                    │
                    └─────────────────────┬──────────────────────────────┘
                                          ▼
                          WSPÓLNY RDZEŃ (src/lib/pipeline)
                          filtr → parser → normalizacja → SHA-256
                          → event_id → idempotencja → wysyłka z retry
                                          │
                                          ▼
                        graph.facebook.com/v21.0/{DATASET_ID}/events
```

Obie ścieżki wołają tę samą funkcję `processInboundEmail`, więc logika istnieje
w jednym miejscu. Ścieżka zapasowa istnieje po to, żeby awaria dostawcy webhooka
nie oznaczała utraty leadów — a że idempotencja opiera się na unikalnym indeksie
`message_id`, uruchomienie obu naraz nigdy nie zdubluje zdarzenia.

**Trzy warstwy zabezpieczenia przed duplikatem:**

| Warstwa | Mechanizm | Co łapie |
|---|---|---|
| 1 | `UNIQUE(processed_emails.message_id)` | ten sam mail z dwóch źródeł |
| 2 | `UNIQUE(lead_events.event_id)` | to samo zdarzenie z dwóch przebiegów |
| 3 | deduplikacja po stronie Meta po `event_id` | wszystko, co przecieknie |

---

## Wymagania

- Node.js ≥ 20.9
- konto Vercel (**plan Pro**, jeśli cron ma chodzić co 5 minut — patrz niżej)
- baza Vercel Postgres (Neon)
- konto u dostawcy inbound parse: **Resend** (domyślnie) albo **Mailgun**
- domena z możliwością ustawienia rekordów MX
- konto reklamowe Meta z dostępem do Menedżera zdarzeń

---

## Instalacja lokalna

```bash
git clone <adres-repozytorium>
cd <katalog>
npm install

cp .env.example .env.local
# uzupełnij .env.local — patrz sekcja „Zmienne środowiskowe”

npm run db:migrate     # utworzenie tabel
npm run dev            # http://localhost:3000
```

Przydatne polecenia:

| Polecenie | Opis |
|---|---|
| `npm run dev` | serwer deweloperski |
| `npm run build` | build produkcyjny |
| `npm test` | testy jednostkowe (vitest) |
| `npm run typecheck` | sprawdzenie typów bez emisji |
| `npm run db:migrate` | uruchomienie migracji |
| `npm run db:generate` | wygenerowanie migracji po zmianie schematu |
| `npm run db:studio` | przeglądarka bazy (Drizzle Studio) |
| `npm run parse:check -- mail.eml` | co parser wyciągnie z konkretnego maila — [patrz niżej](#dostrajanie-parsera) |

`.env`, `.env.local` i wszystkie warianty `.env.*` są w `.gitignore` —
do repozytorium trafia wyłącznie `.env.example` z pustymi wartościami.

---

## Zmienne środowiskowe

**Gdzie je wpisać na Vercelu:** Project → **Settings** → **Environment Variables**.
Zaznacz wszystkie trzy środowiska (Production, Preview, Development) i po dodaniu
zrób **redeploy** — funkcje serverless czytają zmienne przy starcie.

Zmienne są podzielone na grupy walidowane niezależnie (zod). Jeśli korzystasz
tylko z webhooka, możesz pominąć grupę IMAP — cron wykryje jej brak, zaloguje to
i pominie odpytywanie skrzynki, nadal dokańczając zaległe wysyłki.

### Wymagane zawsze

| Zmienna | Opis |
|---|---|
| `META_ACCESS_TOKEN` | token systemowy z uprawnieniem `ads_management` |
| `META_DATASET_ID` | identyfikator zestawu danych / pixela (same cyfry) |
| `POSTGRES_URL` | connection string do Vercel Postgres (dodawany automatycznie) |

### Meta — opcjonalne

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `META_API_VERSION` | `v21.0` | wersja Graph API |
| `META_TEST_MODE` | `false` | gdy `true`, do żądań dokładany jest `test_event_code` |
| `META_TEST_EVENT_CODE` | — | kod z zakładki „Testowanie zdarzeń”; wymagany przy `META_TEST_MODE=true` |

### Webhook poczty (`POST /api/inbound/email`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `INBOUND_PROVIDER` | `resend` | `resend` albo `mailgun` |
| `INBOUND_WEBHOOK_SECRET` | — | Signing Secret (Resend, `whsec_…`) albo HTTP webhook signing key (Mailgun) |
| `INBOUND_SIGNATURE_TOLERANCE_SECONDS` | `300` | tolerancja zegara — ochrona przed atakiem powtórzeniowym |

### Cron i endpoint testowy

| Zmienna | Opis |
|---|---|
| `CRON_SECRET` | losowy sekret ≥ 16 znaków: `openssl rand -hex 32` |

### IMAP (ścieżka zapasowa)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `IMAP_HOST` | — | np. `imap.gmail.com` |
| `IMAP_PORT` | `993` | |
| `IMAP_USER` | — | zwykle pełny adres e-mail |
| `IMAP_PASSWORD` | — | dla Gmaila: **hasło aplikacji**, nie hasło do konta |
| `IMAP_SECURE` | `true` | |
| `IMAP_MAILBOX` | `INBOX` | |
| `IMAP_MAX_MESSAGES_PER_RUN` | `25` | limit maili na jedno wywołanie |
| `IMAP_LOOKBACK_HOURS` | `24` | jak daleko wstecz sięgać |

### Panel

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `DASHBOARD_PASSWORD` | — | min. 12 znaków; jest też kluczem podpisu ciasteczka sesji |
| `DASHBOARD_SESSION_HOURS` | `12` | ważność sesji |

### Strojenie (opcjonalne)

`DEFAULT_EVENT_SOURCE_URL`, `DEFAULT_LISTING_ID`, `DEFAULT_CONTENT_NAME`,
`PHONE_DEFAULT_COUNTRY`, `EVENT_ID_BUCKET_SECONDS`, `META_MAX_ATTEMPTS`,
`META_TIMEOUT_MS`, `META_RETRY_BASE_MS`, `META_RETRY_MAX_DELAY_MS`,
`PENDING_DRAIN_LIMIT`, `PENDING_RETRY_DELAY_SECONDS`, `PENDING_MAX_ATTEMPTS`,
`LOG_LEVEL` oraz reguły rozpoznawania maili (`OTODOM_SENDER_DOMAINS`,
`OTODOM_SUBJECT_PATTERNS`, `OTODOM_EXCLUDED_EMAIL_DOMAINS`) — opisane
w `.env.example`.

> **Uwaga bezpieczeństwa:** żadna z tych zmiennych nie może mieć prefiksu
> `NEXT_PUBLIC_`. Taki prefiks wypycha wartość do bundla przeglądarki, czyli
> publikuje sekret.

---

## Baza danych i migracje

1. Vercel → zakładka **Storage** → **Create Database** → **Postgres** (Neon).
2. Podłącz bazę do projektu — Vercel doda `POSTGRES_URL` automatycznie.
3. Pobierz zmienne lokalnie i uruchom migracje:

```bash
vercel env pull .env.local
npm run db:migrate
```

Migracje leżą w `./drizzle` i są wersjonowane w repozytorium. Skrypt jest
idempotentny — Drizzle trzyma w bazie listę wykonanych migracji.

Po zmianie `src/lib/db/schema.ts` wygeneruj nową migrację:

```bash
npm run db:generate
npm run db:migrate
```

### Schemat

| Tabela | Rola |
|---|---|
| `processed_emails` | jeden wiersz na wiadomość; `UNIQUE(message_id)` |
| `lead_events` | jeden wiersz na zdarzenie CAPI; `UNIQUE(event_id)`, `UNIQUE(message_id)` |
| `dead_letters` | zdarzenia odrzucone przez Meta na stałe albo po wyczerpaniu prób |

Dane osobowe są w bazie **wyłącznie** jako SHA-256 (`em_hash`, `ph_hash`,
`fn_hash`, `ln_hash`, `country_hash`). Nadawca zapisywany jest w formie
zamaskowanej (`j***@otodom.pl`). Kolumna `payload_snapshot` przechowuje gotowy
payload CAPI — również wyłącznie z hashami — dzięki czemu ponowna wysyłka
zachowuje ten sam `event_id` i nie zdubluje konwersji.

---

## Konfiguracja poczty przychodzącej

Idea jest ta sama u obu dostawców: w panelu swojej poczty ustawiasz regułę
przekazywania maili z Otodom na adres obsługiwany przez dostawcę, a dostawca
wysyła je do `POST /api/inbound/email`.

### Wariant A — Resend (domyślny)

1. **Domena:** Resend → **Domains** → *Add Domain*. Dodaj wskazane rekordy MX
   (i SPF/DKIM) w DNS swojej domeny.
2. **Adres odbiorczy:** utwórz adres inbound, np. `otodom@leady.twojadomena.pl`.
3. **Webhook:** Resend → **Webhooks** → *Add Webhook*
   - Endpoint: `https://<twoja-domena-vercel>/api/inbound/email`
   - Zdarzenie: `email.received`
   - Skopiuj **Signing Secret** (zaczyna się od `whsec_`) do `INBOUND_WEBHOOK_SECRET`
4. `INBOUND_PROVIDER=resend`
5. **Reguła w poczcie:** w Gmailu (Ustawienia → Filtry) utwórz filtr
   `from:(otodom.pl)` → *Przekaż do* `otodom@leady.twojadomena.pl`.
   Adres przekazywania trzeba najpierw potwierdzić w Gmailu.

Podpis weryfikowany jest biblioteką `svix` (standard Standard Webhooks) —
razem z oknem czasowym, więc przechwycone żądanie nie da się odtworzyć później.

### Wariant B — Mailgun

1. **Domena:** Mailgun → *Add domain*, ustaw rekordy MX zgodnie z instrukcją.
2. **Route:** Mailgun → **Receiving** → *Create Route*
   - Expression: `match_recipient("otodom@leady.twojadomena.pl")`
   - Action: `forward("https://<twoja-domena-vercel>/api/inbound/email")`
3. **Sekret:** Mailgun → **Sending** → **Webhooks** → *HTTP webhook signing key*
   → wpisz do `INBOUND_WEBHOOK_SECRET`
4. `INBOUND_PROVIDER=mailgun`

Podpis to HMAC-SHA256 z `timestamp + token`, weryfikowany porównaniem odpornym
na atak czasowy, plus kontrola świeżości znacznika czasu.

### Co się dzieje z wiadomością

Brak podpisu albo zły podpis ⇒ **401**, bez żadnego przetwarzania. Po pozytywnej
weryfikacji endpoint odpowiada **200** natychmiast, a właściwą pracę wykonuje
w `after()` z `next/server` — dostawca nie czeka na Meta ani na bazę.

> **Uwaga o `waitUntil`:** w App Routerze Next.js nie eksportuje `waitUntil`
> z `next/server`; odpowiednikiem jest `after()` (stabilne od Next 15.1) i to jego
> używa ten projekt. Efekt jest identyczny — praca trwa po odesłaniu odpowiedzi.

### Filtrowanie

Przetwarzane są tylko wiadomości spełniające reguły z `src/lib/config/patterns.ts`:

- **nadawca** z dozwolonej domeny (sprawdzane też w `Reply-To`, `Return-Path`,
  `X-Original-From` — przekazywanie potrafi podmienić `From:`), **i**
- **temat** pasujący do wzorca **lub** znacznik Otodomu w treści.

Wiadomość przekazana, w której `From:` zostało nadpisane Twoim adresem, przechodzi
na podstawie tematu i treści. Wszystko inne dostaje status `skipped` i wpis w logu —
**bez błędu**.

---

## Cron — ścieżka zapasowa

Wpis w `vercel.json`:

```json
{
  "regions": ["fra1"],
  "crons": [{ "path": "/api/cron/poll-imap", "schedule": "*/5 * * * *" }]
}
```

> ⚠️ **Harmonogram co 5 minut wymaga planu Vercel Pro.** Na planie Hobby cron
> może odpalać maksymalnie **raz dziennie** — zmień wtedy `schedule` na np.
> `"0 3 * * *"`. Główna ścieżka (webhook) działa niezależnie od planu.

**Uwierzytelnienie:** gdy w projekcie ustawiona jest zmienna `CRON_SECRET`,
Vercel automatycznie dokłada nagłówek `Authorization: Bearer <CRON_SECRET>`
do swoich wywołań. Endpoint bez poprawnego nagłówka zwraca 401.

Wywołanie ręczne:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<twoja-domena-vercel>/api/cron/poll-imap
```

Przebieg crona:

1. **Dokańcza zaległości** — zdarzenia `pending` (webhookowi zabrakło czasu
   funkcji) i `failed_retryable` (błąd przejściowy Meta). Faza dostaje 40 %
   budżetu czasu, żeby nie zagłodzić drugiej.
2. **Odpytuje IMAP** — najpierw same koperty (tanie), odsiewa Message-ID już
   obecne w bazie, dopiero potem pobiera pełną treść nowych wiadomości,
   maksymalnie `IMAP_MAX_MESSAGES_PER_RUN`. Zaległość ląduje w logu
   (`cron.backlog_remaining`) razem z podpowiedzią, co podkręcić.

Połączenie IMAP jest zamykane w bloku `finally` — funkcja nie zostawia po sobie
otwartego gniazda.

---

## Token systemowy Meta z uprawnieniem `ads_management`

1. Wejdź na [business.facebook.com](https://business.facebook.com) →
   **Ustawienia firmy** (Business Settings).
2. **Użytkownicy** → **Użytkownicy systemowi** → *Dodaj*. Nadaj nazwę
   (np. `otodom-capi`) i rolę **Administrator systemu**.
3. Kliknij **Przypisz zasoby** i przypisz:
   - konto reklamowe (rola: *Zarządzanie kampaniami*),
   - zestaw danych / pixel (rola: *Zarządzanie zestawem danych*).
4. Kliknij **Wygeneruj nowy token**:
   - wybierz aplikację,
   - zaznacz uprawnienie **`ads_management`** (przydaje się też `business_management`),
   - wygeneruj.
5. **Token pokazuje się tylko raz.** Skopiuj go od razu do
   `META_ACCESS_TOKEN` w zmiennych środowiskowych Vercela.

Identyfikator zestawu danych znajdziesz w **Menedżerze zdarzeń** → **Zestawy
danych** → kolumna *Identyfikator*. W tym projekcie: `1062762802819993` —
wpisz go do `META_DATASET_ID`.

> Alternatywnie token można wygenerować w Menedżerze zdarzeń: wybierz zestaw
> danych → **Ustawienia** → sekcja *Conversions API* → **Wygeneruj token dostępu**.
> Token systemowy z Business Managera jest jednak trwalszy i łatwiejszy do
> odebrania, gdy zajdzie potrzeba.

---

## Weryfikacja zdarzeń w Menedżerze zdarzeń

1. Menedżer zdarzeń → wybierz zestaw danych → zakładka **Testowanie zdarzeń**
   (*Test Events*).
2. Skopiuj kod testowy (format `TEST12345`) i ustaw na Vercelu:
   ```
   META_TEST_MODE=true
   META_TEST_EVENT_CODE=TEST12345
   ```
   Redeploy.
3. Wyślij zdarzenie testowe:
   ```bash
   curl -X POST https://<twoja-domena-vercel>/api/dev/send-test-lead \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
4. Zdarzenie `Lead` powinno pojawić się w zakładce w ciągu kilkunastu sekund.
   Sprawdź, czy Meta raportuje dopasowane parametry (e-mail, telefon, imię,
   nazwisko, kraj).
5. Po weryfikacji ustaw `META_TEST_MODE=false` i zrób redeploy — inaczej zdarzenia
   będą trafiać **wyłącznie** do zakładki testowej i nie zasilą optymalizacji.

### Tryb dry-run

Zwraca gotowy payload bez wysyłki do Meta i bez zapisu w bazie:

```bash
curl -X POST "https://<twoja-domena-vercel>/api/dev/send-test-lead?dryRun=1" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" -d '{}'
```

Zwrócony payload **nie zawiera** tokenu dostępu — token dokleja dopiero klient
HTTP tuż przed wysyłką.

Możesz podać własne dane, żeby sprawdzić parser na konkretnym przypadku:

```bash
curl -X POST "https://<twoja-domena-vercel>/api/dev/send-test-lead?dryRun=1" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"jan@firma.pl","phone":"601 234 567","fullName":"Jan Kowalski","listingId":"64821573"}'
```

Endpoint buduje z tych danych wiadomość w formacie Otodomu i przepuszcza ją przez
**prawdziwy** parser — sprawdzasz więc cały łańcuch, a nie skrót.

---

## Niestandardowa konwersja oparta o zdarzenie Lead

1. Menedżer zdarzeń → **Niestandardowe konwersje** → **Utwórz niestandardową konwersję**.
2. Źródło danych: Twój zestaw danych.
3. Zdarzenie: **Lead**.
4. Reguły (opcjonalnie — jeśli masz kilka ogłoszeń i chcesz je rozdzielić):
   - `lead_source` **równa się** `otodom`
   - `listing_id` **równa się** numerowi Twojego ogłoszenia
   - albo `content_name` **zawiera** fragment tytułu
5. Kategoria: **Kontakt** (lub *Potencjalny klient*).
6. Zapisz. Konwersja jest gotowa do użycia w kampanii po zebraniu pierwszych zdarzeń.

Następnie w Menedżerze reklam ustaw cel kampanii na **Potencjalni klienci**
i wskaż tę konwersję jako zdarzenie optymalizacji.

> Algorytm potrzebuje danych, żeby się uczyć. Przy kilku leadach tygodniowo
> optymalizacja pod samo zdarzenie `Lead` będzie mało skuteczna — rozważ
> optymalizację pod kliknięcia w link z konwersją jako miarą jakości, dopóki
> nie uzbierasz kilkudziesięciu zdarzeń miesięcznie.

---

## Panel `/dashboard`

Server Component chroniony hasłem z `DASHBOARD_PASSWORD`. Pokazuje:

- podsumowanie z ostatnich 24 h,
- ostatnie 100 zdarzeń: status wysyłki, kod odpowiedzi Meta, liczbę prób,
  znacznik czasu, numer ogłoszenia i **skróty hashy** zamiast danych osobowych,
- dead-letter z przyciskiem **Wyślij ponownie**.

Sesja to podpisane ciasteczko `HttpOnly` / `SameSite=Lax` (`Secure` na produkcji).
Kluczem podpisu jest samo hasło — jego zmiana natychmiast unieważnia wszystkie
zalogowane sesje, bez potrzeby trzymania tabeli sesji.

Ponowna wysyłka korzysta z `payload_snapshot`, więc `event_id` i `event_time`
pozostają te same. Jest bezpieczna nawet wtedy, gdy poprzednia próba faktycznie
doszła do Meta, a my nie zdążyliśmy zapisać wyniku — Meta rozpozna duplikat.

### Stan aplikacji

```bash
curl https://<twoja-domena-vercel>/api/health
```

Zwraca stan połączenia z bazą, flagi kompletności każdej grupy konfiguracji
(same `true`/`false`, bez wartości zmiennych) i podsumowanie z ostatniej doby.

---

## Ograniczenia jakości dopasowania

To najważniejsza rzecz do zrozumienia przed oceną wyników.

**Czego nie mamy i mieć nie możemy:**

- `fbc` / `fbp` — ciasteczka kliknięcia i przeglądarki. Powstają dopiero po
  wejściu na stronę z pixelem. Otodom pixela nie ma, a mail ich nie przenosi.
- `client_ip_address`, `client_user_agent` — mail nie zawiera IP ani przeglądarki
  osoby wypełniającej formularz.
- `external_id` — nie prowadzimy własnej bazy klientów.

**Co mamy:** `em`, `ph`, `fn`, `ln`, `country` — wszystko zahaszowane SHA-256.
To wystarcza, żeby Meta dopasowała zdarzenie do konta użytkownika po adresie
e-mail lub numerze telefonu, ale wskaźnik *Event Match Quality* będzie
umiarkowany (realnie okolice 4–6 / 10, nie 8–9).

**Praktyczne konsekwencje:**

- Atrybucja będzie **niepełna** — część leadów Meta nie skojarzy z żadnym kontem
  (np. gdy ktoś podał na Otodom służbowy adres, a na Facebooku ma prywatny).
- Liczba konwersji w Menedżerze reklam będzie **niższa** niż liczba leadów
  w panelu tej aplikacji. To normalne, nie błąd.
- Okno atrybucji: zdarzenie trafia do Meta z opóźnieniem (czas dostarczenia maila
  + przetwarzanie). Meta akceptuje zdarzenia **do 7 dni wstecz** — starsze
  aplikacja odrzuca samodzielnie i zapisuje w dead-letter z powodem
  `event_too_old`, żeby nie marnować prób.

**Co realnie poprawia dopasowanie:**

- Pilnuj, żeby parser wyciągał telefon **i** e-mail (dwa identyfikatory dopasowują
  się lepiej niż jeden). W logu szukaj `parser.fields_missing`.
- Imię i nazwisko dokładają trzeci i czwarty sygnał — warto, żeby Otodom je
  przekazywał w mailu.
- `country` jest ustawiane na stałe na `pl` (z `PHONE_DEFAULT_COUNTRY`).

---

## RODO

Aplikacja przetwarza dane osobowe osób zainteresowanych ogłoszeniem. Poniżej
podsumowanie tego, co system robi technicznie i co musisz uzupełnić prawnie.

### Podstawa prawna

Przekazywanie danych do Meta w celu pomiaru i optymalizacji reklam opiera się
zwykle na **prawnie uzasadnionym interesie administratora** (art. 6 ust. 1 lit. f
RODO) — marketing bezpośredni własnych usług. Jesteś wtedy zobowiązany
przeprowadzić i udokumentować **test równowagi** (LIA).

Bezpieczniejszą i częściej rekomendowaną podstawą jest **zgoda** (art. 6 ust. 1
lit. a). Otodom nie daje możliwości zebrania zgody na przekazanie danych do Meta
w swoim formularzu — jeżeli zdecydujesz się na zgodę jako podstawę, musisz ją
pozyskać przy pierwszym kontakcie zwrotnym, a do tego czasu wstrzymać wysyłkę.

Wobec Meta występujesz jako **współadministrator** w zakresie pomiaru zdarzeń
(warunki Meta dotyczące współadministrowania danymi). Decyzję o podstawie prawnej
i jej udokumentowanie **musisz podjąć samodzielnie, najlepiej po konsultacji
prawnej** — ta aplikacja niczego w tym zakresie nie rozstrzyga.

### Informacja w polityce prywatności

Uzupełnij politykę prywatności (i wskaż ją w odpowiedzi na zapytanie) o:

- fakt przekazywania **zahaszowanych** danych kontaktowych do Meta Platforms
  Ireland Ltd. w celu pomiaru skuteczności reklam,
- podstawę prawną i — przy uzasadnionym interesie — informację o **prawie
  sprzeciwu** (art. 21 RODO),
- kategorie danych: adres e-mail, numer telefonu, imię, nazwisko, kraj —
  wyłącznie w postaci skrótu SHA-256,
- informację o **transferze do USA** i mechanizmie legalizującym (Data Privacy
  Framework / standardowe klauzule umowne),
- okres retencji i sposób realizacji praw.

### Okres retencji

Aplikacja **nie kasuje danych automatycznie** — to świadoma decyzja, bo okres
retencji jest Twoją decyzją biznesową, nie techniczną. Rekomendacja: 12–24 miesiące
dla `lead_events`, po czym usunięcie albo anonimizacja.

Przykładowe czyszczenie starszych niż 12 miesięcy:

```sql
DELETE FROM lead_events    WHERE created_at < now() - interval '12 months';
DELETE FROM processed_emails WHERE created_at < now() - interval '12 months';
DELETE FROM dead_letters   WHERE created_at < now() - interval '12 months';
```

Możesz podpiąć to jako dodatkowy cron. Pamiętaj, że skasowanie
`processed_emails` zdejmuje ochronę idempotencji dla tych wiadomości — trzymaj
okres retencji wyraźnie dłuższy niż `IMAP_LOOKBACK_HOURS`.

### Prawo do usunięcia danych

W bazie nie ma danych w postaci jawnej, więc żeby znaleźć wpisy konkretnej osoby,
policz hash jej adresu tak samo, jak robi to aplikacja:

```bash
printf '%s' "$(echo 'JAN.KOWALSKI@Example.PL' | tr '[:upper:]' '[:lower:]' | tr -d ' ')" \
  | sha256sum
```

```sql
-- podgląd
SELECT event_id, created_at, status FROM lead_events WHERE em_hash = '<hash>';

-- usunięcie
DELETE FROM dead_letters WHERE event_id IN (SELECT event_id FROM lead_events WHERE em_hash = '<hash>');
DELETE FROM lead_events  WHERE em_hash = '<hash>';
```

Analogicznie dla telefonu (`ph_hash`) — wartość normalizowana do E.164 bez plusa,
np. `48601234567`.

**Usunięcie danych po stronie Meta** to osobny proces: Menedżer zdarzeń →
**Usuwanie danych** (*Data Deletion*) albo Graph API `/{dataset_id}/user_data_deletion`.
Sam `DELETE` w naszej bazie nie usuwa danych z Meta.

### Co system robi, żeby ograniczyć ryzyko

- do bazy trafiają **wyłącznie** hashe SHA-256, nigdy dane jawne,
- logi przechodzą przez maskowanie (`j***@otodom.pl`, `********567`) i przez
  filtr wycinający sekrety; treść wiadomości nie jest logowana ani nigdzie zapisywana,
- treść zapytania **nie jest** wysyłana do Meta — `custom_data` zawiera tylko
  `lead_source`, `listing_id` i `content_name`,
- panel pokazuje wyłącznie skróty hashy,
- własne logowanie `imapflow` jest wyłączone (potrafi wypisywać tematy i adresy).

---

## Struktura projektu

```
src/
├── app/
│   ├── api/
│   │   ├── inbound/email/route.ts    POST — webhook (podpis → 401, after(), maxDuration 60)
│   │   ├── cron/poll-imap/route.ts   GET  — cron (Bearer CRON_SECRET)
│   │   ├── dev/send-test-lead/route.ts POST — zdarzenie testowe + dry-run
│   │   └── health/route.ts           GET  — stan bazy i podsumowanie 24 h
│   ├── dashboard/                    panel (Server Component + Server Actions)
│   ├── layout.tsx  page.tsx  globals.css
└── lib/
    ├── config/    env.ts (zod, grupy) · patterns.ts (wzorce Otodom, filtry)
    ├── mail/      types.ts · parse-raw.ts (mailparser) · filter.ts · imap.ts
    │              providers/{index,resend,mailgun,types}.ts
    ├── parser/    otodom.ts · html-to-text.ts · types.ts
    ├── hashing/   normalize.ts (E.164) · hash.ts (SHA-256) · mask.ts
    ├── meta/      event.ts (event_id) · client.ts (retry + budżet) · types.ts
    ├── db/        schema.ts · client.ts · queries.ts
    ├── pipeline/  process-email.ts (rdzeń) · deliver.ts (wysyłka + dead-letter)
    ├── auth/      dashboard.ts (sesja) · secret.ts (Bearer, timing-safe)
    └── logger.ts · time-budget.ts

drizzle/    migracje SQL
scripts/    migrate.ts · parse-check.ts (diagnostyka parsera)
tests/      8 plików, 149 testów
```

### Budżet czasu funkcji

`TimeBudget` pilnuje, żeby funkcja nigdy nie została ubita w trakcie żądania do
Meta. Przed każdą próbą i przed każdym oczekiwaniem klient sprawdza, czy zostało
dość czasu; jeśli nie — zdarzenie zostaje zapisane jako `pending`, a cron dokończy
je przy następnym przebiegu. Dzięki temu wynik wysyłki zawsze trafia do bazy.

---

## Testy

```bash
npm test           # jednorazowo
npm run test:watch # tryb obserwowania
```

Pokrycie:

| Plik | Co sprawdza |
|---|---|
| `parser.test.ts` | parser na 4 przykładowych mailach (tekst, HTML-tabela, przekazany, niepełne) + konwersja HTML→tekst |
| `normalize.test.ts` | normalizacja e-maila i telefonu do E.164 bez plusa, rozbicie imienia i nazwiska |
| `hashing.test.ts` | SHA-256, zakaz podwójnego haszowania, format `user_data`, maskowanie do logów |
| `event-id.test.ts` | determinizm `event_id`, zaokrąglenie timestampu, budowa payloadu, wiek zdarzenia |
| `retry.test.ts` | backoff, 5 prób maks., 4xx bez ponawiania, 429 z `Retry-After`, budżet czasu, brak wycieku tokenu |
| `deliver.test.ts` | mapowanie wyniku wysyłki na stan w bazie i dead-letter |
| `signature.test.ts` | podpisy Svix (Resend) i HMAC (Mailgun), ochrona przed replay, `CRON_SECRET` |
| `filter.test.ts` | reguły nadawcy i tematu, wiadomości przekazane, odsiew spamu |

---

## Dostrajanie parsera

Wzorce rozpoznawania pól są ogólne — obejmują typowe etykiety Otodomu w wersji
polskiej i angielskiej, tekstowej i HTML. Prawdziwy mail może mieć własny układ,
więc jest narzędzie do sprawdzenia tego **lokalnie, bez wdrażania czegokolwiek**:

```bash
# zapisz maila z klienta poczty (Gmail: ⋮ → „Pokaż oryginał" → „Pobierz wiadomość")
npm run parse:check -- ~/Downloads/otodom.eml

# albo wklej samą treść
cat tresc.txt | npm run parse:check
```

Skrypt przechodzi **dokładnie tę samą ścieżkę co produkcja** — filtr → parser →
normalizacja → haszowanie → budowa zdarzenia — i wypisuje:

- decyzję filtra wraz z trzema sygnałami (nadawca / temat / treść),
- każde wyciągnięte pole i **skąd** pochodzi (etykieta, wzorzec awaryjny, wyprowadzone),
- listę pól, których nie udało się wyciągnąć,
- gotowy `event_id` i payload CAPI,
- ile identyfikatorów trafi do Meta (`x/5` — im więcej, tym lepsze dopasowanie).

Nie łączy się z bazą, nie wysyła niczego do Meta i nie potrzebuje ani jednej
zmiennej środowiskowej.

**Dane osobowe w wyniku są domyślnie zamaskowane**, więc wynik można bezpiecznie
komuś pokazać. Pełne wartości — do weryfikacji poprawności na własnej maszynie —
odsłania flaga `--reveal`:

```bash
npm run parse:check -- --reveal ~/Downloads/otodom.eml
```

Kod wyjścia: `0` gdy filtr przepuścił wiadomość, `2` gdy odrzucił — wygodne
w skrypcie sprawdzającym wiele maili naraz.

### Co poprawić, gdy pole nie zostało wyciągnięte

Wszystko siedzi w jednym pliku: `src/lib/config/patterns.ts`.

| Problem | Co zmienić |
|---|---|
| brakuje imienia / e-maila / telefonu | dopisz etykietę z maila do `NAME_LABELS`, `EMAIL_LABELS` albo `PHONE_LABELS` |
| filtr odrzuca prawidłowego leada | poszerz `DEFAULT_SUBJECT_PATTERNS` lub `DEFAULT_SENDER_DOMAINS` (albo bez zmiany kodu: `OTODOM_SUBJECT_PATTERNS`, `OTODOM_SENDER_DOMAINS`) |
| jako lead łapie się adres portalu | dopisz domenę do `OTODOM_EXCLUDED_EMAIL_DOMAINS` |
| numer ogłoszenia nie wychodzi z URL-a | dostrój `LISTING_ID_FROM_URL_PATTERNS` |

Po zmianie dorzuć maila jako fixture w `tests/fixtures/emails.ts` (z zmyślonymi
danymi) i asercję w `tests/parser.test.ts` — wtedy kolejna zmiana wzorców
nie zepsuje po cichu obsługi tego układu.

---

## Rozwiązywanie problemów

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| Webhook zwraca **401** | zły `INBOUND_WEBHOOK_SECRET` albo `INBOUND_PROVIDER` nie zgadza się z faktycznym dostawcą. Sprawdź log `inbound.signature_invalid`. |
| Webhook zwraca **500 `misconfigured`** | brakuje zmiennej środowiskowej. `GET /api/health` pokaże, która grupa jest niekompletna. |
| Maile przychodzą, ale nie ma zdarzeń | filtr je odrzuca. Szukaj `pipeline.skipped` z powodem; ustaw `LOG_LEVEL=debug` i ewentualnie poszerz `OTODOM_SENDER_DOMAINS` / `OTODOM_SUBJECT_PATTERNS`. |
| `pipeline.parse_failed` / `no_identifier` | parser nie znalazł ani e-maila, ani telefonu. Zapisz maila i uruchom `npm run parse:check -- mail.eml` — patrz [Dostrajanie parsera](#dostrajanie-parsera). |
| Zdarzenia wiszą jako `pending` | cron nie chodzi. Sprawdź, czy `CRON_SECRET` jest ustawiony i czy plan Vercel dopuszcza Twój harmonogram. |
| Meta zwraca **400** | najczęściej zły `META_DATASET_ID` albo token bez `ads_management`. Treść odpowiedzi jest w panelu w sekcji dead-letter. |
| Meta zwraca **190** / `Invalid OAuth token` | token wygasł lub został odebrany — wygeneruj nowy (patrz sekcja o tokenie systemowym). |
| Zdarzenia nie widać w „Testowanie zdarzeń” | `META_TEST_MODE` musi być `true`, a `META_TEST_EVENT_CODE` zgodny z kodem widocznym w zakładce. Po zmianie zrób redeploy. |
| Cron loguje `cron.backlog_remaining` | zaległość większa niż limit na przebieg — zwiększ `IMAP_MAX_MESSAGES_PER_RUN` albo skróć `IMAP_LOOKBACK_HOURS`. |
| Błąd logowania IMAP dla Gmaila | wymagane **hasło aplikacji**, nie hasło do konta; włącz też dostęp IMAP w ustawieniach Gmaila. |
