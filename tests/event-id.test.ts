import { describe, expect, it } from "vitest";

import { hashIdentity, sha256Hex } from "@/lib/hashing/hash";
import {
  ACTION_SOURCE,
  EVENT_NAME,
  LEAD_SOURCE,
  MAX_EVENT_AGE_SECONDS,
  buildEventId,
  buildLeadEvent,
  buildRequestBody,
  isEventTooOld,
  resolveIdentityHash,
  toUnixSeconds,
} from "@/lib/meta/event";

const HASHES = hashIdentity({
  email: "anna.kowalska@example.pl",
  phone: "+48 601 234 567",
  firstName: "Anna",
  lastName: "Kowalska",
  country: "PL",
});

const BASE = {
  hashes: HASHES,
  sentAt: new Date("2026-03-12T09:41:17.000Z"),
  messageId: "<abc@otodom.pl>",
  listingId: "64821573",
  listingUrl: "https://www.otodom.pl/pl/oferta/hala-ID4xK9p",
  listingTitle: "Hala produkcyjno-magazynowa Kraków",
};

describe("buildEventId", () => {
  it("jest deterministyczny", () => {
    const args = { identityHash: "abc", listingId: "111", eventTimeSeconds: 1_770_000_000 };
    expect(buildEventId(args)).toBe(buildEventId(args));
  });

  it("zaokrągla timestamp w dół do pełnego okna", () => {
    // Oba znaczniki wpadają w to samo okno 300 s → ten sam event_id.
    const a = buildEventId({ identityHash: "abc", listingId: "1", eventTimeSeconds: 1_770_000_010 });
    const b = buildEventId({ identityHash: "abc", listingId: "1", eventTimeSeconds: 1_770_000_290 });
    expect(a).toBe(b);

    // Kolejne okno daje już inny identyfikator.
    const c = buildEventId({ identityHash: "abc", listingId: "1", eventTimeSeconds: 1_770_000_301 });
    expect(c).not.toBe(a);
  });

  it("odpowiada jawnie policzonemu SHA-256 z trzech składników", () => {
    const eventId = buildEventId({
      identityHash: "abc",
      listingId: "111",
      eventTimeSeconds: 1_770_000_123,
      bucketSeconds: 300,
    });
    const bucket = Math.floor(1_770_000_123 / 300) * 300;
    expect(eventId).toBe(sha256Hex(`abc|111|${bucket}`));
  });

  it("różne ogłoszenie daje różny identyfikator", () => {
    const a = buildEventId({ identityHash: "abc", listingId: "1", eventTimeSeconds: 1_770_000_000 });
    const b = buildEventId({ identityHash: "abc", listingId: "2", eventTimeSeconds: 1_770_000_000 });
    expect(a).not.toBe(b);
  });

  it("różna tożsamość daje różny identyfikator", () => {
    const a = buildEventId({ identityHash: "abc", listingId: "1", eventTimeSeconds: 1_770_000_000 });
    const b = buildEventId({ identityHash: "xyz", listingId: "1", eventTimeSeconds: 1_770_000_000 });
    expect(a).not.toBe(b);
  });

  it("honoruje niestandardową szerokość okna", () => {
    const a = buildEventId({
      identityHash: "abc",
      listingId: "1",
      eventTimeSeconds: 1_770_000_010,
      bucketSeconds: 60,
    });
    const b = buildEventId({
      identityHash: "abc",
      listingId: "1",
      eventTimeSeconds: 1_770_000_290,
      bucketSeconds: 60,
    });
    expect(a).not.toBe(b);
  });
});

describe("resolveIdentityHash", () => {
  it("preferuje hash e-maila", () => {
    expect(resolveIdentityHash(HASHES, "<x@y>")).toBe(HASHES.emHash);
  });

  it("bez e-maila korzysta z telefonu", () => {
    const onlyPhone = hashIdentity({ phone: "601234567" });
    expect(resolveIdentityHash(onlyPhone, "<x@y>")).toBe(onlyPhone.phHash);
  });

  it("bez obu korzysta z Message-ID", () => {
    expect(resolveIdentityHash({}, "<x@y>")).toBe(sha256Hex("<x@y>"));
  });
});

describe("buildLeadEvent", () => {
  const event = buildLeadEvent(BASE);

  it("ustawia wymagane pola zdarzenia", () => {
    expect(event.event_name).toBe(EVENT_NAME);
    expect(event.event_name).toBe("Lead");
    expect(event.action_source).toBe(ACTION_SOURCE);
    expect(event.action_source).toBe("system_generated");
    expect(event.event_time).toBe(toUnixSeconds(BASE.sentAt));
    expect(event.event_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bierze event_source_url z linku w mailu", () => {
    expect(event.event_source_url).toBe(BASE.listingUrl);
  });

  it("gdy brak linku, korzysta z wartości domyślnej z konfiguracji", () => {
    const fallback = buildLeadEvent({ ...BASE, listingUrl: undefined });
    expect(fallback.event_source_url).toBe(
      "https://www.otodom.pl/pl/oferta/domyslne-ogloszenie-IDdefault",
    );
  });

  it("wypełnia custom_data", () => {
    expect(event.custom_data.lead_source).toBe(LEAD_SOURCE);
    expect(event.custom_data.lead_source).toBe("otodom");
    expect(event.custom_data.listing_id).toBe("64821573");
    expect(event.custom_data.content_name).toBe("Hala produkcyjno-magazynowa Kraków");
  });

  it("gdy brak numeru ogłoszenia i tytułu, korzysta z wartości domyślnych", () => {
    const fallback = buildLeadEvent({ ...BASE, listingId: undefined, listingTitle: undefined });
    expect(fallback.custom_data.listing_id).toBe("unknown");
    expect(fallback.custom_data.content_name).toBe("Hala produkcyjno-magazynowa Kraków");
  });

  it("przekazuje wyłącznie zahaszowane dane osobowe", () => {
    const serialized = JSON.stringify(event.user_data);
    expect(serialized).not.toContain("anna.kowalska@example.pl");
    expect(serialized).not.toContain("48601234567");
    expect(event.user_data.em).toEqual([sha256Hex("anna.kowalska@example.pl")]);
    expect(event.user_data.country).toEqual([sha256Hex("pl")]);
  });

  it("ten sam mail przetworzony dwa razy daje ten sam event_id", () => {
    expect(buildLeadEvent(BASE).event_id).toBe(buildLeadEvent(BASE).event_id);
  });

  it("różnica kilkunastu sekund w nagłówku Date nie zmienia event_id", () => {
    const later = buildLeadEvent({
      ...BASE,
      sentAt: new Date(BASE.sentAt.getTime() + 12_000),
    });
    // Obie daty mieszczą się w tym samym oknie 300-sekundowym.
    expect(later.event_id).toBe(buildLeadEvent(BASE).event_id);
  });
});

describe("buildRequestBody", () => {
  it("nie zawiera tokenu dostępu", () => {
    const body = buildRequestBody(buildLeadEvent(BASE));
    expect(JSON.stringify(body)).not.toContain("TOKEN");
    expect(body).not.toHaveProperty("access_token");
    expect(body.data).toHaveLength(1);
  });

  it("dokłada test_event_code, gdy podany", () => {
    const body = buildRequestBody(buildLeadEvent(BASE), { testEventCode: "TEST12345" });
    expect(body.test_event_code).toBe("TEST12345");
  });
});

describe("isEventTooOld", () => {
  const now = 1_800_000_000;

  it("akceptuje zdarzenie sprzed godziny", () => {
    expect(isEventTooOld(now - 3600, now)).toBe(false);
  });

  it("odrzuca zdarzenie starsze niż 7 dni", () => {
    expect(isEventTooOld(now - MAX_EVENT_AGE_SECONDS - 1, now)).toBe(true);
  });
});
