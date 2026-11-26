"""Run inside the built image with networking disabled; uses synthetic config only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('bootstrap', '/usr/local/lib/paseo-daemon/bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    secrets = root / 'secrets'; secrets.mkdir()
    config = root / 'config'; config.mkdir()
    workspace = root / 'workspace'; workspace.mkdir()
    repo = workspace / 'repository'; repo.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    url = 'https://github.com/example/fixture.git'
    subprocess.run(['git', '-C', str(repo), 'remote', 'add', 'origin', url], check=True)
    (workspace / '.paseo-repository-ready').write_text('{}')
    (repo / '.codex').mkdir()
    (repo / '.codex/config.toml').write_text('[mcp_servers.unselected]\nurl="https://unselected.invalid/mcp"\n')
    (secrets / 'files.json').write_text(json.dumps({'config.toml': 'cli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\n[mcp_servers.docs]\nurl="https://example.invalid/mcp"\n'}))
    (config / 'bootstrap.json').write_text(json.dumps({'repository': {'url':url,'revision':''}, 'mcps':['docs'],'trustRepository':True}))
    bootstrap.prepare(workspace, secrets, config, 'smoke-test')
    environment = {**os.environ, 'HOME':str(workspace), 'CODEX_HOME':str(workspace / '.codex'), 'PASEO_HOME':str(workspace / '.paseo')}
    for command in [['paseo','--version'],['codex','--version'],['claude','--version']]:
        print(subprocess.check_output(command, env=environment, text=True).strip())
    result = subprocess.run(['codex','mcp','list','--json'], cwd=repo, env=environment, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert {server['name'] for server in json.loads(result.stdout)} == {'docs'}
    print('Real Codex bootstrap, repository trust and selected MCP config smoke test passed.')
