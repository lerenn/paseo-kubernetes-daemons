#!/usr/bin/env python3
"""Prepare a pod using a selected, immutable credential snapshot. Never log secrets."""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import urlsplit

ALLOWED_FILES = {'auth.json', 'config.toml', '.credentials.json'}

def write_private(path, content):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('unsafe credential destination')
    # Same-filesystem atomic replacement; a pod-local writable copy can refresh independently.
    fd, filename = tempfile.mkstemp(prefix='.bootstrap-', dir=path.parent)
    temp = Path(filename)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

def value(v):
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v): return str(v).lower()
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)): return v.isoformat()
    if isinstance(v, list): return '[' + ', '.join(value(i) for i in v) + ']'
    if isinstance(v, dict): return '{ ' + ', '.join(json.dumps(k) + ' = ' + value(i) for k, i in v.items()) + ' }'
    raise ValueError('unsupported TOML value')

def dump_toml(data):
    return ''.join(json.dumps(k) + ' = ' + value(v) + '\n' for k, v in data.items())

def git(*args, cwd=None, env=None):
    try:
        return subprocess.run(['git', *args], cwd=cwd, env=env, check=True, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        raise ValueError('repository checkout failed; check revision, credentials and network access') from None

def checkout(root, repo):
    url = repo['url']
    # The plugin validates origins too; CRs/config maps can be authored independently.
    if url.startswith('git@'):
        import re
        if not re.fullmatch(r'git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+', url): raise ValueError('unsupported repository URL')
    else:
        parsed = urlsplit(url)
        if parsed.scheme not in ('https', 'ssh') or not parsed.hostname or parsed.password or (parsed.scheme == 'https' and parsed.username) or parsed.query or parsed.fragment:
            raise ValueError('repository URL must not contain credentials')
    revision = repo.get('revision', '')
    import re
    if revision and (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/@+-]*', revision) or '..' in revision): raise ValueError('invalid repository revision')
    destination = root / 'repository'
    if destination.is_symlink(): raise ValueError('unsafe repository destination')
    environment = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    # No token is written into the Git URL, process arguments or Git config.
    if environment.get('GITHUB_TOKEN') and urlsplit(url).scheme == 'https' and urlsplit(url).hostname == 'github.com':
        environment['GIT_ASKPASS'] = str(Path(__file__).with_name('git-askpass.py'))
    if not destination.exists():
        git('clone', '--no-checkout', '--', url, str(destination), env=environment)
    elif not (destination / '.git').is_dir():
        raise ValueError('repository directory already exists without a Git checkout')
    origin = git('-C', str(destination), 'remote', 'get-url', 'origin', env=environment)
    if origin != url: raise ValueError('existing checkout belongs to a different repository')
    # Do not reset user work on init-container retries or pod replacement with a PVC.
    marker = root / '.paseo-repository-ready'
    if not marker.exists():
        try:
            git('-C', str(destination), 'checkout', '--detach', revision or 'origin/HEAD', env=environment)
        except ValueError:
            if not revision or revision.startswith('origin/'):
                raise
            git('-C', str(destination), 'checkout', '--detach', 'origin/' + revision, env=environment)
        write_private(marker, json.dumps({'url': url}))
    return destination

def prepare(root, secret_dir, config_dir, profile):
    root = Path(root)
    if root.is_symlink(): raise ValueError('unsafe workspace root')
    root.mkdir(parents=True, exist_ok=True)
    home = root / '.codex'
    if home.is_symlink() or (home.exists() and not home.is_dir()): raise ValueError('unsafe Codex home')
    home.mkdir(mode=0o700, exist_ok=True)
    home.chmod(0o700)
    files = json.loads((Path(secret_dir) / 'files.json').read_text())
    config = json.loads((Path(config_dir) / 'bootstrap.json').read_text())
    if not isinstance(files, dict) or not files.keys() <= ALLOWED_FILES or 'config.toml' not in files:
        raise ValueError('invalid credential bundle')
    for name, content in files.items():
        if not isinstance(content, str): raise ValueError('invalid credential file')
        if name != 'config.toml': json.loads(content)
    settings = tomllib.loads(files['config.toml'])
    repo = config.get('repository')
    if repo and not config.get('trustRepository'): raise ValueError('repository has not been approved')
    if repo:
        destination = checkout(root, repo)
        settings.setdefault('projects', {})[str(destination)] = {'trust_level': 'trusted'}
        project = destination / '.codex'
        if project.is_symlink(): raise ValueError('unsafe project configuration directory')
        project_config = project / 'config.toml'
        if project_config.is_symlink(): raise ValueError('unsafe project configuration file')
        if project_config.exists():
            data = tomllib.loads(project_config.read_text())
            # Root project config has higher precedence than user config. Remove its MCP
            # definitions so only the explicitly selected, snapshotted definitions are used.
            data.pop('mcp_servers', None)
            # Force portable file stores for the copied credentials.
            data.pop('cli_auth_credentials_store', None)
            data.pop('mcp_oauth_credentials_store', None)
            write_private(project_config, dump_toml(data))
    files['config.toml'] = dump_toml(settings)
    marker = root / '.paseo-bootstrap-profile'
    if marker.is_symlink(): raise ValueError('unsafe bootstrap marker')
    same = marker.exists() and marker.read_text() == profile
    if not same:
        for name in ALLOWED_FILES - files.keys():
            target = home / name
            if target.is_symlink(): raise ValueError('unsafe credential destination')
            target.unlink(missing_ok=True)
    for name, content in files.items():
        target = home / name
        if target.is_symlink(): raise ValueError('unsafe credential destination')
        if not same or not target.exists(): write_private(target, content)
    write_private(marker, profile)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', default='/workspace')
    parser.add_argument('--secrets', default='/var/run/paseo/credentials')
    parser.add_argument('--config', default='/var/run/paseo/config')
    parser.add_argument('--profile', required=True)
    args = parser.parse_args()
    try:
        prepare(args.workspace, args.secrets, args.config, args.profile)
    except Exception:
        # Upstream parser/Git exceptions may embed secrets; never print their raw text.
        print('Workspace bootstrap failed. Check the selected snapshot, repository access and image dependencies.', file=sys.stderr)
        return 1
    print('Workspace bootstrap complete.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
