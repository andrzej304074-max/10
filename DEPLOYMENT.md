# Wdrożenie krok po kroku

Liniowa instrukcja od pustego konta Vercel do działającej wysyłki leadów.
Opis referencyjny każdego elementu jest w [README](./README.md) — tutaj jest
kolejność i weryfikacja.

**Czas:** ok. 1,5 h pracy rozłożone na 5 faz, plus oczekiwanie na propagację
rekordów DNS (zwykle 15 minut, czasem do 24 godzin).

Każda faza kończy się **bramką** — sprawdzeniem, które albo przechodzi, albo
zatrzymuje Cię przed marnowaniem czasu w kolejnej fazie. Nie idź dalej, dopóki
bramka nie przejdzie.

---

## Zanim zaczniesz

Potrzebujesz kont: **Vercel**, **Meta Business Manager** z kontem reklamowym
i dostępem do Menedżera zdarzeń, **Resend**, oraz **domeny z dostępem do
ustawień DNS**.

Wygeneruj dwa sekrety i zapisz je w menedżerze haseł — będą potrzebne
kilkukrotnie:

```bash
openssl rand -hex 32    # → CRON_SECRET
openssl rand -hex 24    # → DASHBOARD_PASSWORD
```

---

## Faza 1 — Vercel i baza danych

*ok. 20 minut*

### 1. Zaimportuj projekt

[vercel.com/new](https://vercel.com/new) → **Import Git Repository** →
`andrzej304074-max/10`.

Nie zmieniaj niczego w ustawieniach — Vercel wykryje Next.js sam. Sekcję
*Environment Variables* pomiń, dodamy je za chwilę. Kliknij **Deploy**.

> Repozytorium ma jedną gałąź, więc staje się produkcyjną automatycznie —
> nic nie trzeba merge'ować.

*Nie widzisz repo na liście?* → *Adjust GitHub App Permissions* → nadaj dostęp.

### 2. Utwórz bazę

Zakładka **Storage** → **Create Database** → **Postgres** (Neon).
Region: **Frankfurt (eu-central-1)** — ten sam co funkcje.
**Connect to Project** → zaznacz projekt i wszystkie środowiska.

Vercel sam doda `POSTGRES_URL`. Nic nie wpisujesz ręcznie.

### 3. Dodaj pierwsze zmienne

**Settings → Environment Variables**, zaznaczając **Production + Preview +
Development**:

| Zmienna | Wartość |
|---|---|
| `META_DATASET_ID` | `1062762802819993` |
| `CRON_SECRET` | pierwszy wygenerowany sekret |
| `DASHBOARD_PASSWORD` | drugi wygenerowany sekret |

`META_ACCESS_TOKEN` dojdzie w fazie 2, zmienne poczty w fazie 3.

### 4. Utwórz tabele

**Najprościej — bez instalowania czegokolwiek (zalecane):**

1. Vercel → **Storage** → Twoja baza
2. Zakładka **Query** *(albo przycisk **Open in Neon** → w konsoli Neon
   **SQL Editor** — jedno i drugie prowadzi do tego samego edytora)*
3. Otwórz [`scripts/manual-migration.sql`](./scripts/manual-migration.sql),
   skopiuj **całą** zawartość, wklej i uruchom

Plik zawiera też wpis do rejestru migracji Drizzle, więc gdybyś kiedyś
uruchomił migracje z komputera, narzędzie rozpozna, że są już wykonane,
i ich nie powtórzy.

**Wariant z terminalem** (wymaga Node.js i sklonowanego repozytorium):

```bash
npm i -g vercel
vercel login
vercel link            # wskaż utworzony projekt
vercel env pull .env.local
npm run db:migrate
```

Oczekujesz: `✔ Migracje wykonane.`

### 5. Wyłącz ochronę deploya

**Settings → Deployment Protection** → *Vercel Authentication* dla
**Production: OFF**.

To nie jest opcjonalne. Przy włączonej ochronie webhook Resend dostanie 401
i **żaden lead nie przejdzie**. Endpoint broni się własnym podpisem, a cron
sekretem — ochrona Vercela jest tu zbędna i szkodliwa.

### 6. Zrób redeploy

**Deployments** → ostatni → **⋯** → **Redeploy**.

Zmienne środowiskowe są czytane przy starcie funkcji, więc bez redeployu stary
build ich nie zobaczy.

### ✓ Bramka fazy 1

```bash
curl https://<twój-projekt>.vercel.app/api/health
```

Szukasz `"database": { "ok": true }`. W sekcji `config` pola `db`, `cron`,
`dashboard` i `app` mają być `true`; `meta`, `inbound` i `imap` na tym etapie
są `false` — **tak ma być**.

Zaloguj się też na `/dashboard` hasłem z `DASHBOARD_PASSWORD`. Tabele będą
puste — to znaczy, że baza odpowiada.

---

## Faza 2 — Meta

*ok. 25 minut*

### 7. Potwierdź identyfikator zestawu danych

**Menedżer zdarzeń** → **Zestawy danych** → kolumna *Identyfikator*.
Powinno być `1062762802819993`. Jeśli nie — użyj tego, co widzisz, i popraw
`META_DATASET_ID`.

### 8. Wygeneruj token systemowy

[business.facebook.com](https://business.facebook.com) → **Ustawienia firmy**:

1. **Użytkownicy** → **Użytkownicy systemowi** → *Dodaj*
   Nazwa: `otodom-capi`, rola: **Administrator systemu**
2. **Przypisz zasoby**:
   - konto reklamowe → *Zarządzanie kampaniami*
   - zestaw danych → *Zarządzanie zestawem danych*
3. **Wygeneruj nowy token**:
   - wybierz aplikację
   - zaznacz uprawnienie **`ads_management`**
   - *Wygeneruj*

> ⚠️ **Token pokazuje się tylko raz.** Skopiuj go od razu do menedżera haseł.

*Wariant szybszy:* Menedżer zdarzeń → zestaw danych → **Ustawienia** → sekcja
*Conversions API* → **Wygeneruj token dostępu**. Token systemowy z Business
Managera jest jednak trwalszy i łatwiej go odebrać, gdy zajdzie potrzeba.

### 9. Włącz tryb testowy

Menedżer zdarzeń → zakładka **Testowanie zdarzeń** → skopiuj kod (format
`TEST12345`).

Dodaj zmienne i zrób **redeploy**:

| Zmienna | Wartość |
|---|---|
| `META_ACCESS_TOKEN` | token z kroku 8 |
| `META_TEST_MODE` | `true` |
| `META_TEST_EVENT_CODE` | kod `TEST…` |

### ✓ Bramka fazy 2

```bash
curl -X POST https://<twój-projekt>.vercel.app/api/dev/send-test-lead \
  -H "Authorization: Bearer <CRON_SECRET>" \
  -H "Content-Type: application/json" -d '{}'
```

Oczekujesz `"outcome": "sent"` i `"status": 200`. Zdarzenie `Lead` pojawi się
w zakładce **Testowanie zdarzeń** w kilkanaście sekund.

| Co widzisz | Co jest nie tak |
|---|---|
| `401` | zły `CRON_SECRET` w poleceniu |
| `"status": 400` | zły `META_DATASET_ID` albo token bez `ads_management` |
| `"status": 190` | token wygasł lub został odebrany — wygeneruj nowy |
| `"outcome": "sent"`, ale pusto w Menedżerze | `META_TEST_MODE` nie jest `true`, albo kod `TEST…` się nie zgadza |

Pełną treść błędu od Meta znajdziesz w `/dashboard` w sekcji **dead-letter**.

**Od tego momentu wiesz, że cała połowa „Meta" działa.** Dopiero teraz warto
ruszać DNS-y.

---

## Faza 3 — Poczta przychodząca

*ok. 30 minut pracy + oczekiwanie na DNS*

### 10. Dodaj domenę w Resend

[resend.com](https://resend.com) → **Domains** → *Add Domain*
(np. `leady.twojadomena.pl`).

Wpisz podane rekordy **MX** oraz SPF/DKIM u operatora swojej domeny.

> ⏸️ **Tu następuje oczekiwanie.** Propagacja to zwykle 15 minut, czasem do
> 24 godzin. Resend pokaże status **Verified**. Możesz w tym czasie zamknąć
> instrukcję i wrócić później — pozostałe kroki tej fazy czekają na ten status.

### 11. Utwórz adres odbiorczy

Np. `otodom@leady.twojadomena.pl`.

### 12. Podłącz webhook

Resend → **Webhooks** → *Add Webhook*:

- Endpoint: `https://<twój-projekt>.vercel.app/api/inbound/email`
- Zdarzenie: **`email.received`**
- Skopiuj **Signing Secret** (zaczyna się od `whsec_`)

### 13. Dodaj zmienne poczty

| Zmienna | Wartość |
|---|---|
| `INBOUND_PROVIDER` | `resend` |
| `INBOUND_WEBHOOK_SECRET` | `whsec_…` |

**Redeploy.** Sprawdź `/api/health` — `config.inbound` ma być `true`.

### 14. Ustaw przekazywanie w Gmailu

1. **Ustawienia → Przekazywanie i POP/IMAP → Dodaj adres przekazywania** →
   `otodom@leady.twojadomena.pl`
2. Gmail wyśle na ten adres **kod potwierdzający**. Odbierzesz go w logach
   Vercela (**Deployments → Functions → `/api/inbound/email`**) albo w panelu
   Resend w podglądzie odebranej wiadomości.
3. **Ustawienia → Filtry → Utwórz filtr**: pole *Od* = `otodom.pl` →
   *Przekaż do* → wybierz dodany adres

### ✓ Bramka fazy 3

Weź dowolny stary mail z Otodom w Gmailu i **przekaż go ręcznie** na
`otodom@leady.twojadomena.pl`.

W ciągu minuty w `/dashboard` powinien pojawić się wiersz ze statusem
**wysłane** i kodem Meta **200**.

| Co widzisz | Co robić |
|---|---|
| brak wiersza | logi Vercela → `inbound.rejected` (podpis) albo `pipeline.skipped` (filtr) |
| status **błąd trwały** | treść odpowiedzi Meta jest w dead-letter |
| wiersz jest, ale brak `em`/`ph` | parser nie znalazł danych — patrz krok 16 |

---

## Faza 4 — Pierwszy prawdziwy lead

### 15. Sprawdź panel

Po pierwszym zapytaniu z Otodom otwórz `/dashboard`. Chcesz zobaczyć: status
**wysłane**, kod **200** i wypełnione skróty hashy w kolumnach *Hash e-mail*
i *Hash telefon*.

### 16. Jeśli jakieś pole się nie wyciągnęło

Zapisz maila (Gmail: **⋮ → Pokaż oryginał → Pobierz wiadomość**) i sprawdź
lokalnie, co widzi parser:

```bash
npm run parse:check -- ~/Downloads/otodom.eml
```

Skrypt pokaże każde pole wraz ze źródłem i listę pól nierozpoznanych. Dostrój
etykiety w `src/lib/config/patterns.ts`, zacommituj i wypchnij — Vercel
zdeployuje sam. Szczegóły w README, sekcja *Dostrajanie parsera*.

---

## Faza 5 — Produkcja

### 17. Wyłącz tryb testowy

`META_TEST_MODE` = `false` → **redeploy**.

> ⚠️ Dopóki jest `true`, zdarzenia trafiają **wyłącznie** do zakładki
> „Testowanie zdarzeń" i **nie zasilają optymalizacji kampanii**. To najczęściej
> zapominany krok całego wdrożenia.

### 18. Utwórz niestandardową konwersję

Menedżer zdarzeń → **Niestandardowe konwersje** → *Utwórz*:

- źródło danych: Twój zestaw danych
- zdarzenie: **Lead**
- reguła: `lead_source` **równa się** `otodom`
  (jeśli masz kilka ogłoszeń, dołóż `listing_id`)
- kategoria: **Kontakt**

### 19. Podepnij pod kampanię

Menedżer reklam → cel **Potencjalni klienci** → zdarzenie optymalizacji:
utworzona konwersja.

> Algorytm potrzebuje danych. Przy kilku leadach tygodniowo optymalizacja pod
> samo zdarzenie `Lead` będzie mało skuteczna — rozważ optymalizację pod
> kliknięcia, traktując konwersje jako miarę jakości, dopóki nie uzbierasz
> kilkudziesięciu zdarzeń miesięcznie.

---

## Opcjonalnie — ścieżka zapasowa IMAP

Włącz ją, gdy główna ścieżka jest już sprawdzona. Chroni przed awarią dostawcy
webhooka.

| Zmienna | Uwaga |
|---|---|
| `IMAP_HOST` | np. `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `IMAP_USER` | pełny adres e-mail |
| `IMAP_PASSWORD` | dla Gmaila **hasło aplikacji**, nie hasło do konta |
| `IMAP_LOOKBACK_HOURS` | `48` przy dziennym cronie (plan Hobby) |

Sprawdzenie:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  https://<twój-projekt>.vercel.app/api/cron/poll-imap
```

---

## Zanim ruszysz z reklamami — RODO

Trzy rzeczy do domknięcia poza kodem:

1. **Podstawa prawna** — uzasadniony interes (wymaga udokumentowanego testu
   równowagi) albo zgoda. Decyzja jest Twoja, najlepiej po konsultacji prawnej.
2. **Polityka prywatności** — informacja o przekazywaniu zahaszowanych danych
   kontaktowych do Meta Platforms Ireland, o transferze do USA i o prawie
   sprzeciwu.
3. **Okres retencji** — aplikacja nic nie kasuje automatycznie. Rekomendacja:
   12–24 miesiące.

Szczegóły, gotowe zapytania SQL do realizacji prawa do usunięcia danych oraz
opis mechanizmów ochronnych — w README, sekcja **RODO**.
