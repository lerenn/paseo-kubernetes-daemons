#!/usr/bin/env python3
"""Prepare a pod using a selected, immutable credential snapshot. Never log secrets."""
import argparse
import datetime
import json
import math
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import urlsplit

ALLOWED_FILES = {'auth.json', 'config.toml', '.credentials.json', 'paseo-providers.json', 'claude-credentials.json'}
PROFILES_FILE = 'paseo-providers.json'
CLAUDE_FILE = 'claude-credentials.json'
PROFILE_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')
# Provider ids that pod daemons define themselves; a synced profile may never replace them.
RESERVED_PROFILES = {'claude', 'codex', 'opencode', 'pi', 'copilot', 'gemini', 'muse', 'antigravity'}

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

def load_files(directory):
    files = json.loads((Path(directory) / 'files.json').read_text())
    if not isinstance(files, dict) or not files.keys() <= ALLOWED_FILES:
        raise ValueError('invalid credential bundle')
    for name, content in files.items():
        if not isinstance(content, str): raise ValueError('invalid credential file')
        if name != 'config.toml': json.loads(content)
    return files

def write_claude_home(directory, content, same):
    """Write a Claude subscription login ({"claudeAiOauth": ...}) into a Claude config directory.

    Only the OAuth entry is accepted, so nothing else from the source file (such as MCP OAuth
    caches) reaches the pod. The first-run flag keeps the CLI from prompting for onboarding."""
    data = json.loads(content)
    oauth = data.get('claudeAiOauth') if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not isinstance(oauth.get('accessToken'), str) or not oauth['accessToken']:
        raise ValueError('invalid Claude credentials')
    for d in (directory.parent, directory):
        if d.is_symlink() or (d.exists() and not d.is_dir()): raise ValueError('unsafe Claude config directory')
        d.mkdir(mode=0o700, exist_ok=True)
        d.chmod(0o700)
    target = directory / '.credentials.json'
    if target.is_symlink(): raise ValueError('unsafe credential destination')
    # A pod-local copy may have refreshed itself; keep it while the synced set is unchanged.
    if not same or not target.exists(): write_private(target, json.dumps({'claudeAiOauth': oauth}))
    state = directory / '.claude.json'
    if state.is_symlink(): raise ValueError('unsafe credential destination')
    if not state.exists(): write_private(state, json.dumps({'hasCompletedOnboarding': True}))

def apply_profiles(root, content, only, same):
    """Merge synced provider profiles into the pod daemon's own config.json (agents.providers).

    `only` None means every profile in the file; an empty set means none. Profile definitions may
    hold API keys, so the file is private (0600). Profiles written by an earlier run and no longer
    wanted are removed; everything else in the daemon's configuration is kept."""
    payload = json.loads(content).get('profiles', {}) if content else {}
    if not isinstance(payload, dict): raise ValueError('invalid provider profiles')
    wanted = {}
    for pid, entry in payload.items():
        if not PROFILE_ID.fullmatch(pid) or pid in RESERVED_PROFILES: raise ValueError('invalid provider profile')
        if not isinstance(entry, dict) or not isinstance(entry.get('provider'), dict): raise ValueError('invalid provider profile')
        auth = entry.get('codexAuth')
        if auth is not None:
            if not isinstance(auth, str): raise ValueError('invalid provider profile')
            json.loads(auth)
        claude = entry.get('claudeAuth')
        if claude is not None:
            if not isinstance(claude, str): raise ValueError('invalid provider profile')
            json.loads(claude)
        if only is None or pid in only: wanted[pid] = entry
    paseo = root / '.paseo'
    if paseo.is_symlink() or (paseo.exists() and not paseo.is_dir()): raise ValueError('unsafe Paseo home')
    paseo.mkdir(mode=0o700, exist_ok=True)
    marker = paseo / '.k8s-profiles'
    config_path = paseo / 'config.json'
    if marker.is_symlink() or config_path.is_symlink(): raise ValueError('unsafe Paseo configuration')
    previous = json.loads(marker.read_text()) if marker.exists() else []
    if not wanted and not previous: return
    config = json.loads(config_path.read_text()) if config_path.exists() else {'version': 1}
    agents = config.setdefault('agents', {})
    providers = agents.setdefault('providers', {})
    for pid in previous: providers.pop(pid, None)
    for pid, entry in wanted.items():
        definition = dict(entry['provider'])
        auth = entry.get('codexAuth')
        if auth is not None:
            home = root / '.codex-profiles' / pid
            for d in (home.parent, home):
                if d.is_symlink() or (d.exists() and not d.is_dir()): raise ValueError('unsafe profile Codex home')
                d.mkdir(mode=0o700, exist_ok=True)
            target = home / 'auth.json'
            if target.is_symlink(): raise ValueError('unsafe credential destination')
            # A pod-local copy may have refreshed itself; keep it while the synced set is unchanged.
            if not same or not target.exists(): write_private(target, auth)
            definition['env'] = {**definition.get('env', {}), 'CODEX_HOME': str(home)}
        claude = entry.get('claudeAuth')
        if claude is not None:
            home = root / '.claude-profiles' / pid
            write_claude_home(home, claude, same)
            definition['env'] = {**definition.get('env', {}), 'CLAUDE_CONFIG_DIR': str(home)}
        providers[pid] = definition
    write_private(config_path, json.dumps(config, indent=2))
    config_path.chmod(0o600)
    write_private(marker, json.dumps(sorted(wanted)))

def merge_providers(files, provider_files, provider_files_subset=None, provider_mcps_subset=None):
    """Merge the shared provider set under the project's own files. Project wins.

    A subset of None means "all"; an empty collection means "none"."""
    merged = {}
    for name, content in provider_files.items():
        if name == 'config.toml': continue
        if provider_files_subset is None or name in provider_files_subset: merged[name] = content
    settings = tomllib.loads(provider_files.get('config.toml', ''))
    # The project owns the trusted-projects table; the provider set never contributes it.
    settings.pop('projects', None)
    servers = settings.get('mcp_servers')
    if servers is not None:
        if not isinstance(servers, dict): raise ValueError('invalid provider configuration')
        if provider_mcps_subset is not None:
            servers = {k: v for k, v in servers.items() if k in provider_mcps_subset}
        settings['mcp_servers'] = servers
    project = tomllib.loads(files['config.toml'])
    project_servers = project.pop('mcp_servers', None)
    settings.update(project)
    if project_servers is not None:
        if not isinstance(project_servers, dict): raise ValueError('invalid project configuration')
        settings['mcp_servers'] = {**settings.get('mcp_servers', {}), **project_servers}
    # Project-level files (normally only config.toml) override provider ones.
    merged.update({k: v for k, v in files.items() if k != 'config.toml'})
    merged['config.toml'] = dump_toml(settings)
    return merged

def prepare(root, secret_dir, config_dir, profile, alias_root=None, providers=None,
            providers_secret_dir=None, provider_files=None, provider_mcps=None, provider_profiles=None):
    root = Path(root)
    if root.is_symlink(): raise ValueError('unsafe workspace root')
    root.mkdir(parents=True, exist_ok=True)
    home = root / '.codex'
    if home.is_symlink() or (home.exists() and not home.is_dir()): raise ValueError('unsafe Codex home')
    home.mkdir(mode=0o700, exist_ok=True)
    home.chmod(0o700)
    files = load_files(secret_dir)
    config = json.loads((Path(config_dir) / 'bootstrap.json').read_text())
    if 'config.toml' not in files: raise ValueError('invalid credential bundle')
    profiles_file = None
    claude_file = None
    if providers:
        files = merge_providers(files, load_files(providers_secret_dir), provider_files, provider_mcps)
        # Marker identity covers both objects so a new provider set refreshes pod copies.
        profile = profile + '+' + providers
        profiles_file = files.pop(PROFILES_FILE, None)
        claude_file = files.pop(CLAUDE_FILE, None)
    settings = tomllib.loads(files['config.toml'])
    repo = config.get('repository')
    if repo and not config.get('trustRepository'): raise ValueError('repository has not been approved')
    if repo:
        destination = checkout(root, repo)
        settings.setdefault('projects', {})[str(destination)] = {'trust_level': 'trusted'}
        if alias_root:
            import re
            if not re.fullmatch(r'/__paseo_kubernetes/[a-z0-9]([-a-z0-9]*[a-z0-9])?/workspace', alias_root):
                raise ValueError('invalid workspace alias')
            settings['projects'][alias_root + '/repository'] = {'trust_level': 'trusted'}
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
    if providers:
        apply_profiles(root, profiles_file, provider_profiles, same)
        # Default Claude config dir of the pod (HOME/.claude). A login that is no longer synced is removed.
        claude_home = root / '.claude'
        claude_marker = claude_home / '.k8s-credentials'
        if claude_file is not None:
            write_claude_home(claude_home, claude_file, same)
            write_private(claude_marker, 'managed')
        elif claude_marker.exists() and not claude_marker.is_symlink():
            (claude_home / '.credentials.json').unlink(missing_ok=True)
            claude_marker.unlink()
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
    parser.add_argument('--alias-root')
    # Shared provider set (design: docs/design/projects-tab.md section 2). Absent = legacy pod.
    parser.add_argument('--providers', help='provider set Secret name (also part of the marker)')
    parser.add_argument('--providers-secrets', default='/var/run/paseo/providers/credentials')
    parser.add_argument('--providers-config', default='/var/run/paseo/providers/config')
    parser.add_argument('--provider-files', help='comma-separated provider files to keep; absent = all, empty = none')
    parser.add_argument('--provider-mcps', help='comma-separated provider MCP servers to keep; absent = all, empty = none')
    parser.add_argument('--provider-profiles', help='comma-separated provider profile ids to keep; absent = all, empty = none')
    args = parser.parse_args()
    try:
        subset = lambda v: None if v is None else {i for i in v.split(',') if i}
        prepare(args.workspace, args.secrets, args.config, args.profile, args.alias_root, args.providers,
                args.providers_secrets, subset(args.provider_files), subset(args.provider_mcps), subset(args.provider_profiles))
    except Exception:
        # Upstream parser/Git exceptions may embed secrets; never print their raw text.
        print('Workspace bootstrap failed. Check the selected snapshot, repository access and image dependencies.', file=sys.stderr)
        return 1
    print('Workspace bootstrap complete.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
