"""Latency budget for audit.py: it runs synchronously after every Bash call.

The fixture mirrors the largest real root it has to walk: about 1,500 files
spread over 70 nested directories. Set CLAUDEGATE_PERF=0 to skip on a slow or
loaded runner; CI keeps it on.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIT = os.path.join(HERE, "..", "audit.py")
sys.path.insert(0, os.path.dirname(AUDIT))
import audit  # noqa: E402

SKIP = os.environ.get("CLAUDEGATE_PERF") == "0"


def best_of(n, fn):
    best = float("inf")
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        best = min(best, (time.perf_counter() - t0) * 1000)
    return best


@unittest.skipIf(SKIP, "CLAUDEGATE_PERF=0")
class AuditPerfTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.mkdtemp()
        cls.cg = os.path.join(cls.home, ".claudegate")
        os.makedirs(os.path.join(cls.cg, "sessions"))
        os.makedirs(os.path.join(cls.cg, "audit", "inflight"))
        cls.root = os.path.join(cls.home, "project")
        old = time.time() - 3600
        n = 0
        for d in range(70):
            # Nested two levels deep, like a monorepo of modules.
            dd = os.path.join(cls.root, "mod%d" % (d // 10), "pkg%d" % d)
            os.makedirs(dd, exist_ok=True)
            for i in range(1500 // 70 + (1 if d < 1500 % 70 else 0)):
                p = os.path.join(dd, "f%d.go" % i)
                with open(p, "w") as f:
                    f.write("package p\n")
                os.utime(p, (old, old))
                n += 1
        cls.files = n
        with open(os.path.join(cls.cg, "workspace-roots.json"), "w") as f:
            json.dump([cls.root], f)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.home, ignore_errors=True)

    def test_warm_scan_under_30ms(self):
        self.assertEqual(self.files, 1500)
        since = int(time.time() * 1000) - 1000
        audit.scan_changed([self.root], since)   # warm the cache
        ms = best_of(5, lambda: audit.scan_changed([self.root], since))
        changed, truncated = audit.scan_changed([self.root], since)
        print("\n  warm scan_changed, 1500 files: %.1f ms" % ms, file=sys.stderr)
        self.assertEqual((changed, truncated), ([], False))
        self.assertLess(ms, 30)

    def test_process_under_60ms(self):
        env = dict(os.environ, HOME=self.home)
        payload = {"tool_name": "Bash", "tool_use_id": "p1", "hook_event_name": "PostToolUse",
                   "session_id": "s", "cwd": self.root, "tool_input": {"command": "true"}}
        rec = os.path.join(self.cg, "audit", "inflight", "p1.json")

        def once():
            with open(rec, "w") as f:
                json.dump({"startedAt": int(time.time() * 1000), "cwd": self.root,
                           "sessionId": "s", "captured": [], "implicit": False,
                           "background": False}, f)
            r = subprocess.run([sys.executable, AUDIT], input=json.dumps(payload), text=True,
                               capture_output=True, env=env)
            self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

        once()
        ms = best_of(5, once)
        print("\n  audit.py process, 1500 files: %.1f ms" % ms, file=sys.stderr)
        self.assertLess(ms, 60)

    def test_process_with_7mb_session_under_35ms(self):
        """One uncaptured change and a 7 MB session for its root: the session
        is searched as bytes and never parsed, since the path is not in it."""
        env = dict(os.environ, HOME=self.home)
        root_hash = hashlib.md5(os.path.normcase(os.path.abspath(self.root)).encode()).hexdigest()
        session = os.path.join(self.cg, "sessions", root_hash + ".json")
        files = {}
        for i in range(700):
            files[os.path.join(self.root, "gen", "g%d.go" % i)] = {
                "originalContent": "x" * 10000, "reviewStatus": "pending",
                "sessionId": "s", "capturedAt": "2026-01-01T00:00:00+00:00"}
        with open(session, "w") as f:
            json.dump({"sessionId": "s", "status": "active", "files": files}, f)
        self.assertGreater(os.path.getsize(session), 7_000_000)
        target = os.path.join(self.root, "mod0", "pkg0", "f0.go")
        payload = {"tool_name": "Bash", "tool_use_id": "p2", "hook_event_name": "PostToolUse",
                   "session_id": "s", "cwd": self.root, "tool_input": {"command": "./gen"}}
        rec = os.path.join(self.cg, "audit", "inflight", "p2.json")
        log = os.path.join(self.cg, "audit", root_hash + ".jsonl")

        def once():
            now = time.time()
            os.utime(target, (now, now))
            with open(rec, "w") as f:
                json.dump({"startedAt": int(now * 1000) - 50, "cwd": self.root,
                           "sessionId": "s", "captured": [], "alreadyPending": [],
                           "implicit": False, "background": False}, f)
            r = subprocess.run([sys.executable, AUDIT], input=json.dumps(payload), text=True,
                               capture_output=True, env=env)
            self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

        try:
            once()
            ms = best_of(5, once)
            with open(log) as f:
                last = json.loads(f.readlines()[-1])
            print("\n  audit.py process, 7 MB session + 1 change: %.1f ms" % ms, file=sys.stderr)
            self.assertEqual(last["missed"], [target])
            self.assertLess(ms, 35)
        finally:
            os.remove(session)
            old = time.time() - 3600
            os.utime(target, (old, old))


if __name__ == "__main__":
    unittest.main()
