import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hasUsableIdentifier,
  hashIdentity,
  hashOnce,
  isSha256Hex,
  sha256Hex,
  toUserData,
} from "@/lib/hashing/hash";
import { maskEmail, maskHash, maskName, maskPhone, maskSender, truncate } from "@/lib/hashing/mask";

describe("sha256Hex", () => {
  it("zwraca 64 znaki hex", () => {
    const digest = sha256Hex("anna.kowalska@example.pl");
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("zgadza się z natywnym crypto", () => {
    const value = "48601234567";
    expect(sha256Hex(value)).toBe(createHash("sha256").update(value, "utf8").digest("hex"));
  });

  it("koduje UTF-8 poprawnie dla polskich znaków", () => {
    expect(sha256Hex("wiśniewska")).toBe(
      createHash("sha256").update("wiśniewska", "utf8").digest("hex"),
    );
  });
});

describe("hashOnce", () => {
  it("nie haszuje wartości, która już jest hashem (Meta tego zabrania)", () => {
    const digest = sha256Hex("anna@example.pl");
    expect(hashOnce(digest)).toBe(digest);
    expect(isSha256Hex(digest)).toBe(true);
  });

  it("haszuje zwykłą wartość", () => {
    expect(hashOnce("anna@example.pl")).toBe(sha256Hex("anna@example.pl"));
  });
});

describe("hashIdentity", () => {
  it("normalizuje przed haszowaniem", () => {
    const hashes = hashIdentity({
      email: "  Anna.Kowalska@Example.PL ",
      phone: "+48 601 234 567",
      firstName: "Anna",
      lastName: "KOWALSKA",
      country: "PL",
    });

    expect(hashes.emHash).toBe(sha256Hex("anna.kowalska@example.pl"));
    expect(hashes.phHash).toBe(sha256Hex("48601234567"));
    expect(hashes.fnHash).toBe(sha256Hex("anna"));
    expect(hashes.lnHash).toBe(sha256Hex("kowalska"));
    expect(hashes.countryHash).toBe(sha256Hex("pl"));
  });

  it("pomija pola, których nie da się znormalizować", () => {
    const hashes = hashIdentity({ email: "brak", phone: "-", firstName: "" });
    expect(hashes.emHash).toBeUndefined();
    expect(hashes.phHash).toBeUndefined();
    expect(hashes.fnHash).toBeUndefined();
  });

  it("hasUsableIdentifier wymaga e-maila albo telefonu", () => {
    expect(hasUsableIdentifier(hashIdentity({ email: "a@b.pl" }))).toBe(true);
    expect(hasUsableIdentifier(hashIdentity({ phone: "601234567" }))).toBe(true);
    expect(hasUsableIdentifier(hashIdentity({ firstName: "Anna", country: "PL" }))).toBe(false);
  });
});

describe("toUserData", () => {
  it("pakuje hashe w tablice zgodnie z formatem Meta", () => {
    const userData = toUserData(hashIdentity({ email: "a@b.pl", country: "PL" }));
    expect(userData.em).toEqual([sha256Hex("a@b.pl")]);
    expect(userData.country).toEqual([sha256Hex("pl")]);
    expect(userData.ph).toBeUndefined();
  });

  it("nie przepuszcza wartości jawnych", () => {
    const userData = toUserData(hashIdentity({ email: "anna@example.pl", phone: "601234567" }));
    expect(JSON.stringify(userData)).not.toContain("anna@example.pl");
    expect(JSON.stringify(userData)).not.toContain("601234567");
  });
});

describe("maskowanie do logów", () => {
  it("maskuje e-mail zostawiając domenę", () => {
    expect(maskEmail("anna.kowalska@example.pl")).toBe("a***@example.pl");
  });

  it("maskuje telefon zostawiając trzy ostatnie cyfry", () => {
    expect(maskPhone("48601234567")).toBe("********567");
  });

  it("maskuje imię", () => {
    expect(maskName("Anna")).toBe("A***");
  });

  it("skraca hash do rozpoznawalnego prefiksu", () => {
    expect(maskHash(sha256Hex("x"))).toHaveLength(9);
  });

  it("maskuje nadawcę podanego z nazwą", () => {
    expect(maskSender("Otodom <powiadomienia@otodom.pl>")).toBe("p***@otodom.pl");
  });

  it("truncate spłaszcza białe znaki i przycina", () => {
    expect(truncate("a\n\n  b", 10)).toBe("a b");
    expect(truncate("x".repeat(20), 5)).toBe("xxxxx…");
  });
});
