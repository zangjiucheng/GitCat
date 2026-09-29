#!/usr/bin/env python3
"""Turn Tauri's base64 signature + pubkey into files `minisign -V` can read.

Tauri stores both as base64 of an ordinary minisign block: the `.sig` next to a
bundle, and `plugins.updater.pubkey` in tauri.conf.json. Decoding them means the
release pipeline can verify a signature it just made with the same check the
updater will make on a user's machine, instead of trusting that `signer sign`
did the right thing.

Usage: minisign-materialize.py <file.sig> <tauri.conf.json> <out.minisig> <out.pub>
"""
import base64
import json
import sys


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    sig_path, conf_path, out_sig, out_pub = sys.argv[1:]

    sig = open(sig_path, encoding="utf-8").read().strip()
    if not sig:
        print(f"{sig_path} is empty", file=sys.stderr)
        return 1
    block = base64.b64decode(sig).decode("utf-8")
    # A minisign signature block is 4 lines: untrusted comment, signature,
    # trusted comment, global signature. Fewer means we decoded something else.
    if len(block.strip().split("\n")) != 4:
        print(f"{sig_path} did not decode to a minisign signature block", file=sys.stderr)
        return 1
    open(out_sig, "w", encoding="utf-8").write(block if block.endswith("\n") else block + "\n")

    pub = json.load(open(conf_path, encoding="utf-8"))["plugins"]["updater"]["pubkey"]
    pub_block = base64.b64decode(pub).decode("utf-8")
    open(out_pub, "w", encoding="utf-8").write(pub_block if pub_block.endswith("\n") else pub_block + "\n")
    print(f"wrote {out_sig} and {out_pub}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
