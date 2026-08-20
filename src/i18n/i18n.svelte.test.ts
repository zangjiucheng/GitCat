// The locale registry is data, but two properties of it are load-bearing and
// easy to break silently: that a locale added to LOCALES is actually offered by
// the pickers (they render straight off this array), and that an untranslated
// key falls back to English rather than rendering the raw key at a user.
import { describe, expect, it } from "vitest";
import { LOCALES, setLocale, t, locale } from "./i18n.svelte.ts";

describe("locale registry", () => {
  it("offers Korean", () => {
    expect(LOCALES.map((l) => l.id)).toContain("ko");
    expect(LOCALES.find((l) => l.id === "ko")?.label).toBe("한국어");
  });

  it("consults the per-locale dictionary, and falls back to the key itself when a key exists nowhere", () => {
    // setLocale() persists to jsdom localStorage (gitcat.locale), which
    // survives for the rest of this file — wrap the switch so a failed
    // assertion can't leave `current` stuck on "ko" for later tests/files.
    try {
      setLocale("ko");
      expect(locale()).toBe("ko");

      // The ko -> en hop is not asserted directly because it needs a key that
      // en has and ko does not, and there is no such key at the moment. Do not
      // read that as an invariant: CONTRIBUTOR POLICY lets a locale lag
      // deliberately, so the next namespace someone adds to en/ alone will
      // create one -- and that hop is exactly what renders it in English.
      // What IS asserted here is that the locale layer gets consulted at all
      // rather than bypassed: the same key returns the ko string under "ko"
      // and the en string under "en".
      expect(t("common.cancel")).toBe("취소");
      setLocale("en");
      expect(t("common.cancel")).toBe("Cancel");

      // Nonsense namespace: present in no locale, so it must fall through
      // <locale> -> en -> the key itself rather than blanking the UI. This
      // exercises only the chain's last hop (unknown key -> key itself), not
      // the ko -> en hop — see the assertions above for that.
      setLocale("ko");
      expect(t("nosuchns.nosuchkey")).toBe("nosuchns.nosuchkey");
    } finally {
      setLocale("en");
    }
  });
});
