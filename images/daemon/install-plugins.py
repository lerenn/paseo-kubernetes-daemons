#!/usr/bin/env python3
"""Run the Paseo daemon and install pinned plugins once it accepts connections.

`paseo plugin install` talks to a running daemon, so it cannot run in the init container. The daemon
is the child of this wrapper (signals are forwarded, its exit code is returned). Install output is
never printed: plugin sources and errors may embed credentials. Plugins removed from the list are
not uninstalled."""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REF = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/@+-]*')
MARKER = '.k8s-plugins'
READY_TIMEOUT = 120
READY_INTERVAL = 2
INSTALL_TIMEOUT = 300

def validate(entries):
    if not isinstance(entries, list) or len(entries) > 16: raise ValueError('invalid plugins')
    result = []
    for e in entries:
        if not isinstance(e, dict) or not e.keys() <= {'source', 'ref'}: raise ValueError('invalid plugin')
        source, ref = e.get('source'), e.get('ref', '')
        if not isinstance(source, str) or not 0 < len(source) <= 300 or source.startswith('-') or re.search(r'\s', source):
            raise ValueError('invalid plugin source')
        if not isinstance(ref, str) or (ref and (len(ref) > 250 or not REF.fullmatch(ref))):
            raise ValueError('invalid plugin ref')
        result.append({'source': source, 'ref': ref})
    return result

def run(args, timeout):
    # Output is captured and dropped on purpose.
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout).returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False

def read_marker(path):
    try:
        if path.is_symlink(): return []
        return validate(json.loads(path.read_text()))
    except (OSError, ValueError):
        return []

def write_marker(path, entries):
    if path.is_symlink(): return
    fd, name = tempfile.mkstemp(prefix='.plugins-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream: json.dump(entries, stream)
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)

def install_all(plugins, home, child, sleep=time.sleep, now=time.monotonic):
    """Wait for the daemon, then install what the marker does not record. Returns the done list."""
    deadline = now() + READY_TIMEOUT
    while not run(['paseo', 'plugin', 'ls', '--json'], 30):
        if child.poll() is not None or now() > deadline:
            print('Plugin install skipped: the daemon did not become ready.', flush=True)
            return None
        sleep(READY_INTERVAL)
    marker = Path(home) / MARKER
    done = read_marker(marker)
    total = len(plugins)
    for index, plugin in enumerate(plugins, 1):
        if plugin in done:
            print(f'Plugin {index}/{total} already installed.', flush=True)
            continue
        args = ['paseo', 'plugin', 'install', plugin['source']] + (['--ref', plugin['ref']] if plugin['ref'] else [])
        if run(args, INSTALL_TIMEOUT):
            done.append(plugin)
            print(f'Plugin {index}/{total} installed.', flush=True)
        else:
            print(f'Plugin {index}/{total} failed.', flush=True)
    try:
        write_marker(marker, done)
    except OSError:
        print('Plugin install state could not be saved.', flush=True)
    return done

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--plugins', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        print('No daemon command given.', file=sys.stderr)
        return 2
    try:
        plugins = validate(json.loads(args.plugins))
    except ValueError:
        # The daemon still starts; only the plugins are skipped.
        print('Plugin list is invalid; no plugin will be installed.', file=sys.stderr)
        plugins = []
    child = subprocess.Popen(command)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda number, _frame: child.send_signal(number))
    if plugins:
        try:
            install_all(plugins, os.environ.get('PASEO_HOME', '/workspace/.paseo'), child)
        except Exception:
            print('Plugin install failed.', flush=True)
    return child.wait()

if __name__ == '__main__':
    sys.exit(main())
