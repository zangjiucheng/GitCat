#!/usr/bin/env python3
"""Point latest.json's entries for one bundle at a new signature.

Repacking a bundle invalidates the signature recorded for it in the updater
manifest, and an updater whose downloaded file fails its signature check
refuses the update — so the manifest has to move with the bytes.

The rule: find the `<platform>-appimage` entry, take its URL, and update every
entry sharing that exact URL. Two things make that the right rule rather than a
key-prefix match:

  * a real latest.json lists `linux-x86_64`, `linux-x86_64-appimage`,
    `linux-x86_64-deb` AND `linux-x86_64-rpm`. The last two are different files
    with different signatures; stamping the AppImage's over theirs would break
    updates for every deb/rpm user, quietly, until one of them tried to update.
  * the bare `linux-x86_64` key is an ALIAS that shares the AppImage's URL, so
    matching on URL picks it up without having to know that.

URLs end in a GitHub asset id, not a file name, which is why this matches whole
URLs rather than looking for a name inside one.

Fails when nothing matches, so a rename upstream cannot turn this into a silent
no-op.

Usage: latest-json-set-linux-sig.py <latest.json> <file.sig> <platform-key>
   e.g. latest-json-set-linux-sig.py latest.json app.sig linux-x86_64-appimage
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    manifest_path, sig_path, key = sys.argv[1:]

    with open(sig_path, encoding="utf-8") as f:
        sig = f.read().strip()
    if not sig:
        print(f"{sig_path} is empty", file=sys.stderr)
        return 1

    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    platforms = manifest.get("platforms", {})

    anchor = platforms.get(key)
    if not anchor or not anchor.get("url"):
        print(f"latest.json has no {key} entry with a url", file=sys.stderr)
        print(f"  entries: {sorted(platforms)}", file=sys.stderr)
        return 1

    url = anchor["url"]
    targets = sorted(k for k, v in platforms.items() if v.get("url") == url)
    changed = [k for k in targets if platforms[k].get("signature") != sig]
    for k in changed:
        platforms[k]["signature"] = sig
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    others = sorted(k for k in platforms if k not in targets and k.startswith(key.rsplit("-", 1)[0]))
    print(f"entries sharing {key}'s asset: {targets}")
    print(f"signatures updated:            {changed or '(already current)'}")
    print(f"left alone (different assets): {others}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
