import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('install_plugins', Path(__file__).parents[1] / 'install-plugins.py')
ip = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ip)

FAKE = '''#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$*" in
  *bad*) echo "SECRET_TOKEN leaked" >&2; exit 1;;
  "plugin ls"*) [ -f "$FAKE_NOT_READY" ] && exit 1;;
esac
exit 0
'''

class InstallPlugins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.bin = base / 'bin'; self.bin.mkdir()
        fake = self.bin / 'paseo'
        fake.write_text(FAKE); fake.chmod(0o755)
        self.log = base / 'log'
        self.home = base / 'home'; self.home.mkdir()
        env = {'PATH': f'{self.bin}:{os.environ["PATH"]}', 'FAKE_LOG': str(self.log), 'PASEO_HOME': str(self.home), 'FAKE_NOT_READY': str(base / 'nope')}
        patcher = patch.dict(os.environ, env)
        patcher.start(); self.addCleanup(patcher.stop)

    def run_main(self, plugins, exit_code=0):
        out = io.StringIO()
        daemon = ['python3', '-c', f'import sys; sys.exit({exit_code})']
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = ip.main(['--plugins', json.dumps(plugins), '--', *daemon])
        return code, out.getvalue()

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_installs_in_order_after_readiness_and_returns_daemon_code(self):
        code, out = self.run_main([{'source': 'github:a/b', 'ref': 'v1.0.0'}, {'source': 'github:c/d'}], 7)
        self.assertEqual(code, 7)
        self.assertEqual(self.calls(), ['plugin ls --json', 'plugin install github:a/b --ref v1.0.0', 'plugin install github:c/d'])
        self.assertIn('Plugin 2/2 installed.', out)
        marker = self.home / '.k8s-plugins'
        self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)
        self.assertEqual(len(json.loads(marker.read_text())), 2)

    def test_idempotent_and_reinstalls_new_entries(self):
        self.run_main([{'source': 'github:a/b', 'ref': 'v1'}])
        self.log.unlink()
        self.run_main([{'source': 'github:a/b', 'ref': 'v1'}, {'source': 'github:a/b', 'ref': 'v2'}])
        self.assertEqual(self.calls(), ['plugin ls --json', 'plugin install github:a/b --ref v2'])

    def test_failure_is_quiet_unrecorded_and_does_not_stop_others(self):
        code, out = self.run_main([{'source': 'github:bad/plugin'}, {'source': 'github:ok/plugin'}])
        self.assertEqual(code, 0)
        self.assertNotIn('SECRET_TOKEN', out)
        self.assertNotIn('bad', out)
        self.assertIn('Plugin 1/2 failed.', out)
        self.assertIn('Plugin 2/2 installed.', out)
        self.assertEqual(json.loads((self.home / '.k8s-plugins').read_text()), [{'source': 'github:ok/plugin', 'ref': ''}])

    def test_invalid_entries_are_rejected(self):
        for bad in ([{'source': '--evil'}], [{'source': 'a b'}], [{'source': 'a', 'ref': '-x'}], [{'source': 'a', 'extra': 1}]):
            with self.assertRaises(ValueError): ip.validate(bad)
        code, out = self.run_main([{'source': '--evil'}], 3)
        self.assertEqual(code, 3)
        self.assertEqual(self.calls(), [])

    def test_unready_daemon_skips_install_without_killing_it(self):
        Path(os.environ['FAKE_NOT_READY']).write_text('x')
        class Child:
            def poll(self): return 0
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIsNone(ip.install_all([{'source': 'a', 'ref': ''}], self.home, Child(), sleep=lambda _: None))
        self.assertNotIn('plugin install', ' '.join(self.calls()))

if __name__ == '__main__':
    unittest.main()
