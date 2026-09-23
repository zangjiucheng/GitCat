// The locale registry is data, but two properties of it are load-bearing and
// easy to break silently: that a locale added to LOCALES is actually offered by
// the pickers (they render straight off this array), and that an untranslated
// key falls back to English rather than rendering the raw key at a user.
import { describe, expect, it } from "vitest";
import { LOCALES, setLocale, t, locale, beReject, decodeBackendError } from "./i18n.svelte.ts";

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

// -- beReject -------------------------------------------------------------
//
// The seam legacy/main.ts's `tinvoke` uses, so a keyed backend error cannot
// reach a handler still wearing its wire format. #186 was what that looks
// like in the UI: the key and the 0x1f separators, printed at the user.
describe("beReject", () => {
  const SEP = "\u001f";

  it("resolves the keyed string a Result<_, String> command rejects with", () => {
    const wire = `i18n:err_repo.cannot_open_repo${SEP}detail${SEP}repository path '//wsl.localhost/x' is not owned by current user`;
    const out = beReject(wire);
    expect(typeof out).toBe("string");
    expect(out).not.toContain("i18n:");
    expect(out).not.toContain(SEP);
    expect(out).toContain("//wsl.localhost/x");
  });

  it("passes a plain string through, because not every backend error is keyed", () => {
    // watch.rs's start_watching returns a bare format!() string, and git's own
    // stderr arrives the same way. Both must survive unchanged.
    expect(beReject("cannot open repository: no such file")).toBe("cannot open repository: no such file");
  });

  it("leaves a non-string rejection alone, identity included", () => {
    // The reason this is not just `be`: console.error wants the Error, with
    // its stack. Flattening it to "Error: ..." would be a worse trade than the
    // bug this function exists for.
    const err = new Error("boom");
    expect(beReject(err)).toBe(err);

    const weird = { code: 7 };
    expect(beReject(weird)).toBe(weird);
    expect(beReject(undefined)).toBe(undefined);
    expect(beReject(null)).toBe(null);
  });
});

// -- decodeBackendError -----------------------------------------------------
//
// be()'s own raw-params half — for the rare caller (wslReffix.ts) that needs
// a specific param's value, not just the translated display text.
describe("decodeBackendError", () => {
  const SEP = "";

  it("splits the key and every name/value pair out of a keyed error", () => {
    const wire = `i18n:err_misc.wsl_ref_permission_denied${SEP}path${SEP}/home/j/repo${SEP}detail${SEP}permission denied`;
    expect(decodeBackendError(wire)).toEqual({
      key: "err_misc.wsl_ref_permission_denied",
      params: { path: "/home/j/repo", detail: "permission denied" },
    });
  });

  it("returns null for anything without the i18n: prefix", () => {
    expect(decodeBackendError("fatal: not a git repository")).toBeNull();
    expect(decodeBackendError(null)).toBeNull();
    expect(decodeBackendError(undefined)).toBeNull();
  });
});
