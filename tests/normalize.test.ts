import { describe, expect, it } from "vitest";

import {
  isPlausibleEmail,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizePhoneDetailed,
  splitFullName,
} from "@/lib/hashing/normalize";

describe("normalizeEmail", () => {
  it("przycina i sprowadza do małych liter", () => {
    expect(normalizeEmail("  Anna.Kowalska@Example.PL ")).toBe("anna.kowalska@example.pl");
  });

  it("wyciąga adres z formy 'Nazwa <adres>'", () => {
    expect(normalizeEmail("Jan Kowalski <JAN@firma.pl>")).toBe("jan@firma.pl");
  });

  it("usuwa prefiks mailto: i końcową interpunkcję z treści maila", () => {
    expect(normalizeEmail("mailto:kontakt@firma.pl")).toBe("kontakt@firma.pl");
    expect(normalizeEmail("kontakt@firma.pl.")).toBe("kontakt@firma.pl");
    expect(normalizeEmail("(kontakt@firma.pl)")).toBe("kontakt@firma.pl");
  });

  it("odrzuca wartości, które nie są adresem", () => {
    expect(normalizeEmail("brak")).toBeUndefined();
    expect(normalizeEmail("a@b")).toBeUndefined();
    expect(normalizeEmail("dwa@znaki@example.pl")).toBeUndefined();
    expect(normalizeEmail("@example.pl")).toBeUndefined();
    expect(normalizeEmail("jan@example..pl")).toBeUndefined();
    expect(normalizeEmail("")).toBeUndefined();
    expect(normalizeEmail(undefined)).toBeUndefined();
  });

  it("isPlausibleEmail pilnuje domeny najwyższego poziomu", () => {
    expect(isPlausibleEmail("jan@firma.pl")).toBe(true);
    expect(isPlausibleEmail("jan@firma.p1")).toBe(false);
    expect(isPlausibleEmail("jan@firma.")).toBe(false);
  });
});

describe("normalizePhone — E.164 bez znaku plus, domyślnie PL", () => {
  const cases: Array<[string, string | undefined]> = [
    ["+48 601 234 567", "48601234567"],
    ["0048601234567", "48601234567"],
    ["48-601-234-567", "48601234567"],
    ["601 234 567", "48601234567"],
    ["601-234-567", "48601234567"],
    ["(601) 234 567", "48601234567"],
    ["0601234567", "48601234567"],
    ["+48601234567", "48601234567"],
    ["  +48 (601) 234-567  ", "48601234567"],
    // numer zagraniczny podany międzynarodowo zostaje jak jest
    ["+49 170 1234567", "491701234567"],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      expect(normalizePhone(input)).toBe(expected);
    });
  }

  it("odrzuca wartości, które nie są numerem", () => {
    expect(normalizePhone("-")).toBeUndefined();
    expect(normalizePhone("brak")).toBeUndefined();
    expect(normalizePhone("")).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });

  it("odrzuca zbyt krótkie ciągi cyfr (rok, kod pocztowy)", () => {
    expect(normalizePhoneDetailed("2026").value).toBeUndefined();
    expect(normalizePhoneDetailed("30-001").value).toBeUndefined();
  });

  it("odrzuca numery dłuższe niż E.164", () => {
    expect(normalizePhoneDetailed("+48 1234567890123456").reason).toBe("too_long");
  });

  it("respektuje inny kraj domyślny", () => {
    expect(normalizePhone("1701234567", "DE")).toBe("491701234567");
  });
});

describe("normalizeName", () => {
  it("sprowadza do małych liter i usuwa interpunkcję", () => {
    expect(normalizeName("  Anna   KOWALSKA! ")).toBe("anna kowalska");
  });

  it("zachowuje polskie znaki diakrytyczne i łącznik w nazwisku", () => {
    expect(normalizeName("Maria Wiśniewska-Zając")).toBe("maria wiśniewska-zając");
  });

  it("usuwa cyfry", () => {
    expect(normalizeName("Jan2 Kowalski")).toBe("jan kowalski");
  });

  it("zwraca undefined dla pustej wartości", () => {
    expect(normalizeName("   ")).toBeUndefined();
    expect(normalizeName("123")).toBeUndefined();
  });
});

describe("splitFullName", () => {
  it("rozbija imię i nazwisko", () => {
    expect(splitFullName("Anna Kowalska")).toEqual({ firstName: "anna", lastName: "kowalska" });
  });

  it("przy jednym członie zwraca samo imię", () => {
    expect(splitFullName("Anna")).toEqual({ firstName: "anna" });
  });

  it("przy trzech członach bierze pierwszy i ostatni", () => {
    expect(splitFullName("Anna Maria Kowalska")).toEqual({
      firstName: "anna",
      lastName: "kowalska",
    });
  });

  it("pomija grzecznościowe zwroty", () => {
    expect(splitFullName("Pani Anna Kowalska")).toEqual({
      firstName: "anna",
      lastName: "kowalska",
    });
  });

  it("zwraca pusty obiekt dla braku danych", () => {
    expect(splitFullName(undefined)).toEqual({});
  });
});

describe("normalizeCountry", () => {
  it("przyjmuje kod alpha-2 i sprowadza do małych liter", () => {
    expect(normalizeCountry("PL")).toBe("pl");
  });

  it("odrzuca nazwy krajów", () => {
    expect(normalizeCountry("Polska")).toBeUndefined();
  });
});
