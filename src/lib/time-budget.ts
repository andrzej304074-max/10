/**
 * Budżet czasu dla pojedynczego wywołania funkcji serverless.
 *
 * Vercel ubija funkcję po `maxDuration`. Nie chcemy zostać ubici w trakcie
 * wysyłki do Meta, bo wtedy nie zapiszemy wyniku do bazy i stracimy ślad.
 * Dlatego każda operacja sieciowa pyta budżet, czy ma jeszcze czas — a jeśli
 * nie, zdarzenie zostaje zapisane jako `pending` i dokończy je cron.
 */
export class TimeBudget {
  private readonly deadline: number;

  /**
   * @param totalMs   Całkowity limit czasu funkcji (np. maxDuration * 1000).
   * @param reserveMs Rezerwa na zapisy do bazy i zwrócenie odpowiedzi.
   * @param now       Wstrzykiwalny zegar (dla testów).
   */
  constructor(
    totalMs: number,
    private readonly reserveMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = this.now() + totalMs - reserveMs;
  }

  /** Ile milisekund zostało do końca budżetu (nigdy poniżej zera). */
  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  /** Czy zostało co najmniej `ms` milisekund. */
  hasAtLeast(ms: number): boolean {
    return this.remainingMs() >= ms;
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** Rezerwa zadeklarowana przy tworzeniu budżetu (do logów diagnostycznych). */
  get reserve(): number {
    return this.reserveMs;
  }

  /**
   * Budżet podrzędny, żeby jedna faza (np. drenaż zaległości) nie zjadła całego
   * czasu przeznaczonego na drugą (np. odpytanie IMAP).
   */
  slice(fraction: number): TimeBudget {
    const portion = Math.max(0, this.remainingMs() * fraction);
    return new TimeBudget(portion, 0, this.now);
  }
}

/** Budżet, który nigdy się nie kończy — do testów i trybu dry-run. */
export function unlimitedBudget(): TimeBudget {
  return new TimeBudget(Number.MAX_SAFE_INTEGER / 4, 0);
}
