import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook.py")


class AuditInflightTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.cg = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.cg, "sessions"))
        self.root = os.path.join(self.home, "project")
        os.makedirs(self.root)
        with open(os.path.join(self.cg, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)
        self.inflight = os.path.join(self.cg, "audit", "inflight")
        open(os.path.join(self.root, "f.go"), "w").write("package a\n")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_hook(self, payload):
        return subprocess.run([sys.executable, HOOK], input=json.dumps(payload), text=True,
                              capture_output=True, env=dict(os.environ, HOME=self.home))

    def bash(self, command, **extra):
        p = {"tool_name": "Bash", "cwd": self.root, "session_id": "s",
             "tool_input": {"command": command}}
        p.update(extra)
        return p

    def record(self, tid):
        with open(os.path.join(self.inflight, tid + ".json")) as f:
            return json.load(f)

    def test_bash_writes_inflight(self):
        before = int(time.time() * 1000)
        r = self.run_hook(self.bash("sed -i s/a/b/ f.go", tool_use_id="t1"))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        rec = self.record("t1")
        self.assertEqual(rec["captured"], [os.path.join(self.root, "f.go")])
        self.assertIs(rec["implicit"], False)
        self.assertIs(rec["background"], False)
        self.assertEqual(rec["cwd"], self.root)
        self.assertEqual(rec["sessionId"], "s")
        self.assertGreaterEqual(rec["startedAt"], before)
        self.assertEqual([n for n in os.listdir(self.inflight) if n.endswith(".tmp")], [])

    def test_already_pending_kept_apart(self):
        self.run_hook(self.bash("sed -i s/a/b/ f.go", tool_use_id="t1"))
        self.run_hook(self.bash("sed -i s/a/b/ f.go", tool_use_id="t2"))
        self.assertEqual(self.record("t1")["captured"], [os.path.join(self.root, "f.go")])
        self.assertEqual(self.record("t1")["alreadyPending"], [])
        self.assertEqual(self.record("t2")["captured"], [])
        self.assertEqual(self.record("t2")["alreadyPending"], [os.path.join(self.root, "f.go")])

    def test_inflight_is_private(self):
        self.run_hook(self.bash("sed -i s/a/b/ f.go", tool_use_id="t1"))
        self.assertEqual(os.stat(self.inflight).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.dirname(self.inflight)).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(self.inflight, "t1.json")).st_mode & 0o777, 0o600)

    def test_background_flag(self):
        p = self.bash("sed -i s/a/b/ f.go", tool_use_id="t1")
        p["tool_input"]["run_in_background"] = True
        self.run_hook(p)
        self.assertIs(self.record("t1")["background"], True)

    def test_implicit_flag(self):
        self.run_hook(self.bash("git pull", tool_use_id="t1"))
        rec = self.record("t1")
        self.assertIs(rec["implicit"], True)
        self.assertEqual(rec["captured"], [])

    def test_no_tool_use_id_no_record(self):
        self.run_hook(self.bash("sed -i s/a/b/ f.go"))
        self.assertFalse(os.path.exists(self.inflight) and os.listdir(self.inflight))

    def test_write_tool_no_record(self):
        self.run_hook({"tool_name": "Write", "tool_use_id": "t1", "cwd": self.root,
                       "session_id": "s", "tool_input": {"file_path": "f.go"}})
        self.assertFalse(os.path.exists(os.path.join(self.inflight, "t1.json")))

    def test_stale_inflight_removed(self):
        os.makedirs(self.inflight)
        old = os.path.join(self.inflight, "old.json")
        fresh = os.path.join(self.inflight, "fresh.json")
        for p in (old, fresh):
            open(p, "w").write("{}")
        t = time.time() - 7200
        os.utime(old, (t, t))
        self.run_hook(self.bash("ls", tool_use_id="t1"))
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(fresh))

    def test_stale_removal_capped(self):
        os.makedirs(self.inflight)
        t = time.time() - 7200
        for i in range(60):
            p = os.path.join(self.inflight, "o%d.json" % i)
            open(p, "w").write("{}")
            os.utime(p, (t, t))
        self.run_hook(self.bash("ls", tool_use_id="t1"))
        left = [n for n in os.listdir(self.inflight) if n.startswith("o")]
        self.assertEqual(len(left), 10)

    def _files_under_audit(self):
        top = os.path.join(self.cg, "audit")
        out = []
        for d, _, files in os.walk(top):
            out.extend(os.path.join(d, f) for f in files)
        return out

    def test_traversal_id_writes_nothing(self):
        r = self.run_hook(self.bash("sed -i s/a/b/ f.go", tool_use_id="../evil"))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertEqual(self._files_under_audit(), [])
        self.assertFalse(os.path.exists(os.path.join(self.cg, "audit", "evil.json")))
        self.assertFalse(os.path.exists(os.path.join(self.cg, "evil.json")))

    def test_overlong_id_writes_nothing(self):
        r = self.run_hook(self.bash("sed -i s/a/b/ f.go", tool_use_id="a" * 129))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertEqual(self._files_under_audit(), [])

    def test_captured_deduplicated(self):
        self.run_hook(self.bash("sed -i s/a/b/ f.go && sed -i s/b/c/ f.go", tool_use_id="t1"))
        self.assertEqual(self.record("t1")["captured"], [os.path.join(self.root, "f.go")])

    def test_sweep_examines_at_most_200(self):
        # In process, with the removal cap lifted, so the examined cap is the
        # one that stops the sweep: of 260 stale records exactly 200 go.
        sys.path.insert(0, os.path.dirname(HOOK))
        try:
            import hook
        finally:
            sys.path.pop(0)
        os.makedirs(self.inflight)
        t = time.time() - 7200
        for i in range(260):
            p = os.path.join(self.inflight, "o%d.json" % i)
            open(p, "w").write("{}")
            os.utime(p, (t, t))
        saved = hook.AUDIT_INFLIGHT_DIR, hook.AUDIT_MAX_REMOVALS
        hook.AUDIT_INFLIGHT_DIR, hook.AUDIT_MAX_REMOVALS = self.inflight, 10000
        try:
            hook._audit_inflight({"tool_name": "Bash"}, 0, self.root, "s", [], [], False, False)
        finally:
            hook.AUDIT_INFLIGHT_DIR, hook.AUDIT_MAX_REMOVALS = saved
        self.assertEqual(len(os.listdir(self.inflight)), 60)

    def test_inflight_failure_is_silent(self):
        os.makedirs(os.path.join(self.cg, "audit"))
        open(os.path.join(self.inflight), "w").write("not a dir")
        r = self.run_hook(self.bash("sed -i s/a/b/ f.go", tool_use_id="t1"))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        sessions = os.path.join(self.cg, "sessions")
        body = "".join(open(os.path.join(sessions, n)).read() for n in os.listdir(sessions))
        self.assertIn(os.path.join(self.root, "f.go"), body)


if __name__ == "__main__":
    unittest.main()
