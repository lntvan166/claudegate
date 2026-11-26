#!/usr/bin/env python3
"""Summarise ~/.claudegate/audit/*.jsonl: how well shell-write capture did.

    python3 hooks/tools/audit_report.py [--days N] [--root PATH]

recall    = captured / (captured + missed)
precision = captured / (captured + phantom)

Uses the *Count fields (the lists are capped at 200). Background calls are
skipped; truncated calls (the scan ran out of budget) are counted apart and
left out of the sums. Corrupt lines are skipped. Reads .jsonl and .jsonl.1.

Blind spots: an mtime scan cannot see deletions, or moves/copies that keep
mtime. A call rejected before it runs, or cancelled mid-run, leaves an
in-flight record but no audit line, so it is not counted here at all.

Dev tool, not shipped in the VSIX. Stdlib only.
"""

import argparse
import glob
import hashlib
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

FIELDS = ("calls", "captured", "missed", "uncertain", "phantom", "covered",
          "implicit", "outOfScope", "truncated")
BLIND_SPOT = "mtime scan cannot see deletions, or moves/copies that keep mtime"


def audit_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".claudegate", "audit")


def _hash(root: str) -> str:
    return hashlib.md5(os.path.normcase(os.path.abspath(root)).encode()).hexdigest()


def _files(root=None) -> list:
    d = audit_dir()
    stem = _hash(root) if root else "*"
    out = []
    for pat in (stem + ".jsonl", stem + ".jsonl.1"):
        out.extend(sorted(glob.glob(os.path.join(d, pat))))
    return out


def _int(v) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0


def _parse_at(s):
    try:
        dt = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def read_lines(root=None, days=None, now=None):
    cutoff = None
    if days is not None:
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=days)
    for path in _files(root):
        try:
            f = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with f:
            for raw in f:
                try:
                    line = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(line, dict):
                    continue
                at = _parse_at(line.get("at"))
                if at is None or (cutoff is not None and at < cutoff):
                    continue
                yield at, line


def summarise(lines) -> dict:
    days = {}
    heads = Counter()
    skipped_bg = 0
    for at, line in lines:
        if line.get("background") is True:
            skipped_bg += 1
            continue
        row = days.setdefault(at.astimezone(timezone.utc).date().isoformat(),
                              dict.fromkeys(FIELDS, 0))
        row["calls"] += 1
        if line.get("truncated") is True:
            row["truncated"] += 1
            continue
        for k in ("captured", "uncertain", "covered", "implicit", "outOfScope"):
            row[k] += _int(line.get(k))
        row["missed"] += _int(line.get("missedCount"))
        row["phantom"] += _int(line.get("phantomCount"))
        if _int(line.get("missedCount")):
            head = " ".join(str(line.get("commandHead") or "").split()[:2]) or "(empty)"
            heads[head] += _int(line.get("missedCount"))
    return {"days": days, "heads": heads, "skippedBackground": skipped_bg}


def _ratio(num, den):
    return "n/a" if den == 0 else "%.1f%%" % (100.0 * num / den)


def _fix_uncertain(lines):
    """Map uncertainCount onto `uncertain` so summarise() stays generic."""
    for at, line in lines:
        line = dict(line)
        line["uncertain"] = line.get("uncertainCount")
        yield at, line


def render(summary: dict) -> str:
    days = summary["days"]
    cols = ("day",) + FIELDS
    rows = [[d] + [str(days[d][k]) for k in FIELDS] for d in sorted(days)]
    total = dict.fromkeys(FIELDS, 0)
    for r in days.values():
        for k in FIELDS:
            total[k] += r[k]
    rows.append(["TOTAL"] + [str(total[k]) for k in FIELDS])
    widths = [max(len(c), *(len(r[i]) for r in rows)) for i, c in enumerate(cols)]
    out = ["  ".join(c.rjust(widths[i]) if i else c.ljust(widths[i]) for i, c in enumerate(cols))]
    for r in rows:
        out.append("  ".join(v.rjust(widths[i]) if i else v.ljust(widths[i]) for i, v in enumerate(r)))
    out.append("")
    out.append("recall    = captured / (captured + missed)  : %s"
               % _ratio(total["captured"], total["captured"] + total["missed"]))
    out.append("precision = captured / (captured + phantom) : %s"
               % _ratio(total["captured"], total["captured"] + total["phantom"]))
    if summary["skippedBackground"]:
        out.append("background calls skipped: %d" % summary["skippedBackground"])
    out.append("truncated calls are counted but contribute no files: %d" % total["truncated"])
    out.append("")
    out.append("top command prefixes with misses:")
    if summary["heads"]:
        for head, n in summary["heads"].most_common(20):
            out.append("  %5d  %s" % (n, head))
    else:
        out.append("  (none)")
    out.append("")
    out.append("Blind spots: " + BLIND_SPOT + ".")
    out.append("A call rejected before it runs, or cancelled mid-run, leaves no audit line.")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=None, help="only the last N days")
    ap.add_argument("--root", default=None, help="only this workspace root")
    args = ap.parse_args(argv)
    print(render(summarise(_fix_uncertain(read_lines(args.root, args.days)))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
