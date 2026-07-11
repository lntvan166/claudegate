import json
import os
import subprocess
import sys
import unittest
import tempfile
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook.py")


class HookLogTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.cg = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.cg, "sessions"))
        self.root = os.path.join(self.home, "project")
        os.makedirs(self.root)
        with open(os.path.join(self.cg, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)
        self.logfile = os.path.join(self.cg, "hook.log")
        self.sentinel = os.path.join(self.cg, "hooklog.enabled")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_hook(self, rel, tool="Edit"):
        payload = json.dumps({
            "tool_name": tool, "cwd": self.root,
            "tool_input": {"file_path": rel}, "session_id": "s",
        })
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)

    def enable_log(self):
        open(self.sentinel, "w").close()

    def test_no_log_without_sentinel(self):
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)
        self.assertFalse(os.path.exists(self.logfile), "no log file when sentinel absent")

    def test_captured_logged_with_sentinel(self):
        self.enable_log()
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)
        self.assertTrue(os.path.exists(self.logfile))
        body = open(self.logfile).read()
        self.assertIn("captured", body)
        self.assertIn(p, body)

    def test_binary_skip_logged(self):
        self.enable_log()
        p = os.path.join(self.root, "img.bin")
        with open(p, "wb") as f:
            f.write(bytes([0x89, 0xff, 0xfe, 0x00]))
        self.run_hook(p)
        self.assertIn("skip-binary", open(self.logfile).read())

    def test_no_root_skip_logged(self):
        self.enable_log()
        outside = os.path.join(self.home, "outside", "x.txt")
        os.makedirs(os.path.dirname(outside))
        open(outside, "w").write("v")
        self.run_hook(outside)
        self.assertIn("skip-no-root", open(self.logfile).read())

    def test_log_self_truncates(self):
        self.enable_log()
        # Pre-fill the log beyond the cap; the next write should reset it small.
        with open(self.logfile, "w") as f:
            f.write("x" * 1_200_000)
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)
        self.assertLess(os.path.getsize(self.logfile), 1_000_000, "log truncated past the cap")
        self.assertIn("captured", open(self.logfile).read())

    def test_error_path_logged_and_fails_open(self):
        # workspace-roots.json is valid JSON but a non-iterable (a bare number):
        # it parses, so it isn't caught by the loader's guard, then `for root in
        # roots` raises TypeError — an unexpected error that must hit the
        # top-level fail-open handler, log an `error` line, and still exit 0.
        self.enable_log()
        with open(os.path.join(self.cg, "workspace-roots.json"), "w") as f:
            f.write("5")
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)  # check=True asserts exit 0 (fail open)
        body = open(self.logfile).read()
        self.assertIn("error", body, "top-level handler logged an error line")

    def test_logging_failure_never_breaks_hook(self):
        # Sentinel present but the log path is unwritable (a directory) — the
        # hook must still exit 0 and capture normally.
        os.mkdir(self.logfile)  # occupy hook.log path with a directory
        self.enable_log()
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)  # check=True asserts exit 0
        sf = os.listdir(os.path.join(self.cg, "sessions"))
        self.assertEqual(len(sf), 1, "capture still happened despite unwritable log")


if __name__ == "__main__":
    unittest.main()
