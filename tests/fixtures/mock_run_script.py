from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def parse_unknown_args(items):
    out = {}
    idx = 0
    while idx < len(items):
        token = items[idx]
        if token.startswith("--"):
            key = token[2:].replace("-", "_").upper()
            value = True
            if idx + 1 < len(items) and not items[idx + 1].startswith("--"):
                value = items[idx + 1]
                idx += 1
            out[key] = value
        idx += 1
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--received-json", required=True)
    parser.add_argument("--payload-json", default="")
    parser.add_argument("--script-id", default="")
    parser.add_argument("--script-path", default="")
    parser.add_argument("--mode", default="")
    parser.add_argument("--style", default="")
    parser.add_argument("--max-parallel", type=int, default=0)
    parser.add_argument("--cwd", default="")
    parser.add_argument("--preview-hash", default="")
    parser.add_argument("--payload-hash", default="")
    known, unknown = parser.parse_known_args(argv)
    received = parse_unknown_args(unknown)
    payload = {}
    if known.payload_json:
        payload_path = Path(known.payload_json)
        if payload_path.exists():
            payload = json.loads(payload_path.read_text(encoding="utf-8"))
    output = {
        "script_id": known.script_id,
        "script_path": known.script_path,
        "mode": known.mode,
        "style": known.style,
        "max_parallel": known.max_parallel,
        "cwd": known.cwd,
        "preview_hash": known.preview_hash,
        "payload_hash": known.payload_hash,
        "received_params": received,
        "payload": payload,
        "argv": sys.argv[1:],
    }
    received_path = Path(known.received_json)
    received_path.parent.mkdir(parents=True, exist_ok=True)
    received_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "received_json": str(received_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
