import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import audit_report  # noqa: E402


def line(at, **kw):
    base = {"at": at.isoformat(), "background": False, "truncated": False,
            "commandHead": "sed -i x f", "missed": [], "uncertain": [], "phantom": [],
            "missedCount": 0, "uncertainCount": 0, "phantomCount": 0, "covered": 0,
            "implicit": 0, "outOfScope": 0, "tooLarge": 0, "captured": 0}
    base.update(kw)
    return json.dumps(base)


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.old = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        self.d = os.path.join(self.home, ".claudegate", "audit")
        os.makedirs(self.d)

    def tearDown(self):
        if self.old is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.old
        shutil.rmtree(self.home, ignore_errors=True)

    def write(self, name, lines):
        with open(os.path.join(self.d, name), "w") as f:
            f.write("\n".join(lines) + "\n")

    def test_totals_skips_and_rotated_file(self):
        now = datetime.now(timezone.utc)
        self.write("a.jsonl", [
            line(now, captured=3, missedCount=1, missed=["x"] * 200, commandHead="git pull origin", phantomCount=1),
            "{not json",
            line(now, background=True, captured=99, missedCount=99),
            line(now, truncated=True, captured=50, missedCount=50),
            line(now, uncertainCount=2, covered=4, implicit=5, outOfScope=6),
        ])
        self.write("a.jsonl.1", [line(now - timedelta(days=1), captured=1, missedCount=1)])
        s = audit_report.summarise(audit_report._fix_uncertain(audit_report.read_lines()))
        tot = {k: sum(r[k] for r in s["days"].values()) for k in audit_report.FIELDS}
        self.assertEqual(tot["calls"], 4)          # background and corrupt excluded
        self.assertEqual(tot["truncated"], 1)
        self.assertEqual(tot["captured"], 4)       # truncated line adds nothing
        self.assertEqual(tot["missed"], 2)         # the *Count, not the 200-entry list
        self.assertEqual(tot["phantom"], 1)
        self.assertEqual((tot["uncertain"], tot["covered"], tot["implicit"], tot["outOfScope"]), (2, 4, 5, 6))
        self.assertEqual(s["skippedBackground"], 1)
        self.assertEqual(s["heads"]["git pull"], 1)
        out = audit_report.render(s)
        self.assertIn("recall    = captured / (captured + missed)  : 66.7%", out)
        self.assertIn("precision = captured / (captured + phantom) : 80.0%", out)
        self.assertIn("mtime scan cannot see deletions, or moves/copies that keep mtime", out)

    def test_days_filter_and_empty(self):
        now = datetime.now(timezone.utc)
        self.write("a.jsonl", [line(now - timedelta(days=10), captured=1)])
        s = audit_report.summarise(audit_report._fix_uncertain(audit_report.read_lines(days=3)))
        self.assertEqual(s["days"], {})
        self.assertIn("n/a", audit_report.render(s))

    def test_root_filter(self):
        now = datetime.now(timezone.utc)
        root = os.path.join(self.home, "proj")
        self.write(audit_report._hash(root) + ".jsonl", [line(now, captured=1)])
        self.write("other.jsonl", [line(now, captured=7)])
        got = list(audit_report.read_lines(root=root))
        self.assertEqual(len(got), 1)


if __name__ == "__main__":
    unittest.main()
