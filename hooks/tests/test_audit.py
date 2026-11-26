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


def md5(p):
    return hashlib.md5(os.path.normcase(os.path.abspath(p)).encode()).hexdigest()


class AuditTestBase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        self.cg = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.cg, "sessions"))
        self.inflight = os.path.join(self.cg, "audit", "inflight")
        os.makedirs(self.inflight)
        self.root = os.path.join(self.home, "project")
        os.makedirs(self.root)
        self.roots = [self.root]
        self.write_roots()
        self.start = int(time.time() * 1000) - 2000
        # Everything pre-existing is old.
        self.old = (self.start - 60000) / 1000.0

    def tearDown(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home
        shutil.rmtree(self.home, ignore_errors=True)

    def write_roots(self):
        with open(os.path.join(self.cg, "workspace-roots.json"), "w") as f:
            json.dump(self.roots, f)

    def put(self, rel, body="x\n", changed=False, root=None):
        p = os.path.join(root or self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w" if isinstance(body, str) else "wb") as f:
            f.write(body)
        t = (self.start + 100) / 1000.0 if changed else self.old
        os.utime(p, (t, t))
        return p

    def record(self, tid="t1", captured=(), implicit=False, background=False, started=None):
        rec = {"startedAt": self.start if started is None else started, "cwd": self.root,
               "sessionId": "s", "captured": list(captured), "implicit": implicit,
               "background": background}
        with open(os.path.join(self.inflight, tid + ".json"), "w") as f:
            json.dump(rec, f)

    def payload(self, tid="t1", event="PostToolUse", command="sed -i s/a/b/ a.go"):
        return {"tool_name": "Bash", "tool_use_id": tid, "hook_event_name": event,
                "session_id": "s", "cwd": self.root, "tool_input": {"command": command}}

    def lines(self, root=None):
        p = os.path.join(self.cg, "audit", md5(root or self.root) + ".jsonl")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return [json.loads(l) for l in f if l.strip()]

    def one(self, root=None):
        ls = self.lines(root)
        self.assertEqual(len(ls), 1, ls)
        return ls[0]

    def audit_files(self):
        top = os.path.join(self.cg, "audit")
        return sorted(n for n in os.listdir(top) if n.endswith(".jsonl") or ".jsonl." in n)


class AuditClassifyTest(AuditTestBase):
    def test_missed_file(self):
        a = self.put("a.go", changed=True)
        self.put("old.go")
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["missed"], [a])
        self.assertEqual(line["captured"], 0)
        self.assertEqual(line["root"], os.path.normcase(self.root))
        self.assertEqual(line["toolUseId"], "t1")
        self.assertEqual(line["sessionId"], "s")
        self.assertEqual(line["commandHead"], "sed -i s/a/b/ a.go")
        self.assertEqual(set(line), {"at", "sessionId", "toolUseId", "event", "durationMs", "cwd",
                                     "root", "commandHead", "background", "truncated", "missed",
                                     "uncertain", "phantom", "covered", "implicit", "outOfScope",
                                     "captured"})
        self.assertFalse(os.path.exists(os.path.join(self.inflight, "t1.json")))

    def test_captured_not_missed(self):
        a = self.put("a.go", changed=True)
        self.record(captured=[a, a])
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["missed"], [])
        self.assertEqual(line["captured"], 1)

    def test_phantom(self):
        b = self.put("b.go")
        self.record(captured=[b])
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["phantom"], [b])
        self.assertEqual(line["captured"], 0)

    def test_phantom_never_created(self):
        ghost = os.path.join(self.root, "sub", "ghost.go")
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            json.dump({"files": {ghost: {"originalContent": None, "reviewStatus": "pending",
                                         "capturedAt": "x"}}}, f)
        self.record(captured=[ghost])
        audit.run(self.payload())
        self.assertEqual(self.one()["phantom"], [ghost])

    def test_captured_deleted_is_a_change(self):
        gone = os.path.join(self.root, "gone.go")
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            json.dump({"files": {gone: {"originalContent": "x", "reviewStatus": "pending",
                                        "capturedAt": "x"}}}, f)
        self.record(captured=[gone])
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["phantom"], line["captured"]), ([], 1))

    def test_implicit_never_missed(self):
        self.put("a.go", changed=True)
        self.record(implicit=True)
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["missed"], [])
        self.assertEqual(line["implicit"], 1)

    def test_gitignored_out_of_scope(self):
        subprocess.run(["git", "init", "-q", self.root], check=True)
        self.put(".gitignore", "bin/\n")
        self.put("bin/x", changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["outOfScope"], 1)
        self.assertEqual(line["missed"], [])

    def test_gitignored_in_nested_repo(self):
        subprocess.run(["git", "init", "-q", self.root], check=True)
        inner = os.path.join(self.root, "inner")
        os.makedirs(inner)
        subprocess.run(["git", "init", "-q", inner], check=True)
        self.put("inner/.gitignore", "*.log\n")
        self.put("inner/app.log", changed=True)
        a = self.put("inner/a.go", changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["outOfScope"], line["missed"]), (1, [a]))

    def test_binary_out_of_scope(self):
        self.put("img.bin", b"\x89PNG\x00\x01\x02", changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["outOfScope"], line["missed"]), (1, []))

    def test_pending_elsewhere_is_covered(self):
        a = self.put("a.go", changed=True)
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            json.dump({"files": {a: {"originalContent": "x", "reviewStatus": "pending",
                                     "sessionId": "other", "capturedAt": "2026-01-01T00:00:00+00:00"}}}, f)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["covered"], line["missed"]), (1, []))

    def test_pending_in_worktree_session_is_covered(self):
        wt = os.path.join(self.root, "wt")
        a = self.put("wt/a.go", changed=True)
        with open(os.path.join(self.cg, "sessions", md5(wt) + ".json"), "w") as f:
            json.dump({"files": {a: {"originalContent": "x", "reviewStatus": "pending",
                                     "capturedAt": "x"}}}, f)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.one()["covered"], 1)

    def test_long_call_uncertain(self):
        started = int(time.time() * 1000) - 11000
        self.start = started
        a = self.put("a.go", changed=True)
        self.record(started=started)
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["uncertain"], line["missed"]), ([a], []))
        self.assertGreaterEqual(line["durationMs"], 11000)

    def test_innermost_root_attribution(self):
        sub = os.path.join(self.root, "sub")
        self.roots.append(sub)
        self.write_roots()
        c = self.put("sub/c.go", changed=True)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.lines(self.root), [])
        self.assertEqual(self.one(sub)["missed"], [c])

    def test_unrelated_root_not_scanned(self):
        other = os.path.join(self.home, "other")
        self.roots.append(other)
        self.write_roots()
        self.put("z.go", changed=True, root=other)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.lines(other), [])

    def test_prune_and_symlink(self):
        self.put("node_modules/pkg/index.js", changed=True)
        self.put(".git/index", changed=True)
        outside = os.path.join(self.home, "outside")
        os.makedirs(outside)
        self.put("o.go", changed=True, root=outside)
        os.symlink(outside, os.path.join(self.root, "link"))
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.lines(), [])

    def test_excluded_not_seen(self):
        with open(os.path.join(self.cg, "excludes.json"), "w") as f:
            json.dump({self.root: [".superpowers/sdd", "**/*.snap"]}, f)
        self.put(".superpowers/sdd/plan.md", changed=True)
        self.put("x/y.snap", changed=True)
        a = self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.one()["missed"], [a])

    def test_no_change_writes_nothing(self):
        self.put("a.go")
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.audit_files(), [])

    def test_background_flag_kept(self):
        self.put("a.go", changed=True)
        self.record(background=True)
        audit.run(self.payload())
        self.assertIs(self.one()["background"], True)

    def test_post_failure_event_also_audited(self):
        self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload(event="PostToolUseFailure"))
        self.assertEqual(self.one()["event"], "PostToolUseFailure")

    def test_command_head_truncated(self):
        self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload(command="x" * 500))
        self.assertEqual(len(self.one()["commandHead"]), 120)


class AuditScanTest(AuditTestBase):
    def test_scan_stops_at_budget(self):
        for d in range(50):
            dd = os.path.join(self.root, "d%d" % d)
            os.makedirs(dd)
            for i in range(100):
                open(os.path.join(dd, "f%d.go" % i), "w").close()
        t0 = time.perf_counter()
        _, truncated = audit.scan_changed([self.root], 0, budget_ms=1)
        elapsed = (time.perf_counter() - t0) * 1000
        self.assertIs(truncated, True)
        self.assertLess(elapsed, 50)

    def test_truncated_flag_in_line(self):
        for d in range(20):
            dd = os.path.join(self.root, "d%d" % d)
            os.makedirs(dd)
            for i in range(100):
                open(os.path.join(dd, "f%d.go" % i), "w").close()
        a = self.put("a.go")
        self.record(captured=[a])
        audit.run(self.payload(), budget_ms=0)
        self.assertIs(self.one()["truncated"], True)

    def test_no_git_uses_prune_list(self):
        subprocess.run(["git", "init", "-q", self.root], check=True)
        self.put(".gitignore", "bin/\n")
        b = self.put("bin/x", changed=True)
        self.record()
        saved = os.environ.get("PATH")
        os.environ["PATH"] = self.home   # no git here
        try:
            audit.run(self.payload())
        finally:
            os.environ["PATH"] = saved
        self.assertEqual(self.one()["missed"], [b])

    def test_rotate_at_5mb(self):
        p = os.path.join(self.cg, "audit", "r.jsonl")
        with open(p, "w") as f:
            f.write("x" * 5_000_000)
        audit.rotate(p)
        self.assertFalse(os.path.exists(p))
        self.assertEqual(os.path.getsize(p + ".1"), 5_000_000)
        with open(p, "w") as f:
            f.write("small")
        audit.rotate(p)
        self.assertTrue(os.path.exists(p))
        # A second rotation replaces the one old file.
        with open(p, "w") as f:
            f.write("y" * 5_000_001)
        audit.rotate(p)
        self.assertEqual(os.path.getsize(p + ".1"), 5_000_001)
        self.assertEqual(sorted(os.listdir(os.path.dirname(p))), ["inflight", "r.jsonl.1"])

    def test_append_rotates(self):
        self.put("a.go", changed=True)
        target = os.path.join(self.cg, "audit", md5(self.root) + ".jsonl")
        with open(target, "w") as f:
            f.write("x" * 5_000_000)
        self.record()
        audit.run(self.payload())
        self.assertTrue(os.path.exists(target + ".1"))
        self.assertEqual(len(self.lines()), 1)

    def test_exclude_cases_match_hook(self):
        with open(os.path.join(HERE, "exclude_cases.json")) as f:
            cases = json.load(f)
        for c in cases["cases"]:
            got = audit.is_excluded(c["path"], c.get("root", cases["root"]), c["globs"])
            self.assertEqual(got, c["excluded"], c)


class AuditProcessTest(AuditTestBase):
    def run_audit(self, stdin):
        return subprocess.run([sys.executable, AUDIT], input=stdin, text=True,
                              capture_output=True, env=dict(os.environ, HOME=self.home))

    def assert_silent(self, r):
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertEqual(self.audit_files(), [])

    def test_missing_inflight_is_silent(self):
        self.put("a.go", changed=True)
        self.assert_silent(self.run_audit(json.dumps(self.payload())))
        p = self.payload()
        del p["tool_use_id"]
        self.assert_silent(self.run_audit(json.dumps(p)))
        self.assert_silent(self.run_audit("not json {"))
        self.assert_silent(self.run_audit(""))
        self.assert_silent(self.run_audit("[1, 2]"))
        self.assert_silent(self.run_audit(json.dumps(self.payload(tid="../evil"))))

    def test_garbage_record_is_silent(self):
        self.put("a.go", changed=True)
        with open(os.path.join(self.inflight, "t1.json"), "w") as f:
            f.write("{garbage")
        self.assert_silent(self.run_audit(json.dumps(self.payload())))
        self.assertFalse(os.path.exists(os.path.join(self.inflight, "t1.json")))

    def test_process_writes_line(self):
        a = self.put("a.go", changed=True)
        self.record()
        r = self.run_audit(json.dumps(self.payload()))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertEqual(self.one()["missed"], [a])


if __name__ == "__main__":
    unittest.main()
