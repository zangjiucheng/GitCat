//! Machine-readable, frontend-translatable error strings for APP-AUTHORED
//! messages (Linear PER-82).
//!
//! An app-authored error is returned as `i18n:<ns>.<key>` (optionally followed
//! by `\x1f name \x1f value` pairs, one per `{name}` placeholder in the
//! localized string). The frontend's `be()` (see `src/i18n/i18n.svelte.ts`)
//! detects the `i18n:` prefix, looks the key up, and interpolates the params.
//!
//! CONTRIBUTOR POLICY: English is the SOURCE OF TRUTH. A key here maps to an
//! `en/<ns>.ts` string on the frontend; the zh translation is best-effort and
//! falls back to English automatically. A contributor who doesn't read Chinese
//! can add a new message with an English string only, and nothing breaks — there
//! is no CI gate requiring zh parity.
//!
//! Raw `git` stderr is NEVER wrapped: it carries no `i18n:` prefix, so `be()`
//! passes it through verbatim. The app pins `LC_ALL=C` to parse git, so git's
//! own text can't be localized anyway — that passthrough is by design, not a gap.
//! Only prose the APP itself writes (`Err("Couldn't …")`, `format!("… failed")`,
//! `.ok_or_else(|| "…")`, `.map_err(|e| format!("… {e}"))`) becomes a key.

/// Unit Separator — matches `BE_SEP` in `src/i18n/i18n.svelte.ts`. Never appears
/// in real message text, so it's a safe delimiter between the key and each
/// param name/value.
const SEP: char = '\u{1f}';

/// `i18n:<key>` — an app-authored error with no interpolated values. `key` is a
/// frontend `"<namespace>.<key>"` such as `"err_repo.cannot_open"`.
pub fn ierr(key: &str) -> String {
    format!("i18n:{key}")
}

/// `i18n:<key>` plus a `SEP name SEP value` pair for each `{name}` placeholder in
/// the localized string. The values (a path, an io/git detail, a count) travel
/// verbatim and are interpolated on the frontend; they are NOT themselves
/// localized (an OS/io error string stays in its own language, like git stderr).
pub fn ierrp(key: &str, params: &[(&str, &str)]) -> String {
    let mut s = format!("i18n:{key}");
    for (k, v) in params {
        s.push(SEP);
        s.push_str(k);
        s.push(SEP);
        s.push_str(v);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ierr_just_prefixes_the_key() {
        assert_eq!(ierr("err_repo.cannot_open"), "i18n:err_repo.cannot_open");
    }

    #[test]
    fn ierrp_encodes_params_with_the_unit_separator() {
        assert_eq!(
            ierrp("err_repo.cannot_write", &[("path", "/tmp/x"), ("detail", "denied")]),
            "i18n:err_repo.cannot_write\u{1f}path\u{1f}/tmp/x\u{1f}detail\u{1f}denied"
        );
    }

    #[test]
    fn ierrp_with_no_params_matches_ierr() {
        assert_eq!(ierrp("a.b", &[]), ierr("a.b"));
    }
}
