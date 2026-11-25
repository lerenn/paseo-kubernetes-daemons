import importlib.util
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).parents[1] / 'bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.workspace = self.base / 'workspace'
        self.secrets = self.base / 'secrets'; self.secrets.mkdir()
        self.config = self.base / 'config'; self.config.mkdir()
        self.files = {'auth.json': json.dumps({'tokens': {'access_token': 'PRIVATE_AUTH'}}),
                      'config.toml': '[mcp_servers.docs]\nurl="https://docs.example/mcp"\n'}
        self.settings = {'repository': None, 'mcps': ['docs'], 'trustRepository': False}
        self.save()
    def save(self):
        (self.secrets / 'files.json').write_text(json.dumps(self.files))
        (self.config / 'bootstrap.json').write_text(json.dumps(self.settings))
    def prepare(self, profile='profile-v1'):
        bootstrap.prepare(self.workspace, self.secrets, self.config, profile)

class BootstrapTest(Base):
    def test_writable_private_copies_survive_restart_without_resetting_refreshed_tokens(self):
        self.prepare()
        auth = self.workspace / '.codex/auth.json'
        self.assertEqual(auth.stat().st_mode & 0o777, 0o600)
        auth.write_text('refreshed')
        self.prepare()
        self.assertEqual(auth.read_text(), 'refreshed')
        self.prepare('profile-v2')
        self.assertIn('PRIVATE_AUTH', auth.read_text())
    def test_unselected_old_credentials_are_removed_on_profile_change(self):
        self.files['.credentials.json'] = '{}'; self.save(); self.prepare()
        del self.files['auth.json']; del self.files['.credentials.json']; self.save()
        self.prepare('profile-v2')
        self.assertFalse((self.workspace / '.codex/auth.json').exists())
        self.assertFalse((self.workspace / '.codex/.credentials.json').exists())
    def test_rejects_path_traversal_and_symlink_destinations(self):
        self.files['../stolen'] = 'PRIVATE'; self.save()
        with self.assertRaises(ValueError): self.prepare()
        del self.files['../stolen']; self.save()
        self.workspace.mkdir(exist_ok=True)
        (self.workspace / '.codex').rmdir()
        (self.workspace / '.codex').symlink_to(self.base / 'outside')
        with self.assertRaises(ValueError): self.prepare()
    def test_approved_repo_gets_portable_trust_and_only_selected_root_mcps(self):
        repo = self.workspace / 'repository'; (repo / '.codex').mkdir(parents=True)
        project = repo / '.codex/config.toml'
        project.write_text('model = "test"\n[mcp_servers.unselected]\nurl="http://localhost:3000/mcp"\n')
        self.settings = {'repository': {'url':'https://github.com/example/repo.git','revision':''}, 'mcps':['docs'], 'trustRepository':True}; self.save()
        with patch.object(bootstrap, 'checkout', return_value=repo): self.prepare()
        config = tomllib.loads((self.workspace / '.codex/config.toml').read_text())
        self.assertEqual(config['projects'][str(repo)]['trust_level'], 'trusted')
        self.assertEqual(set(config['mcp_servers']), {'docs'})
        self.assertNotIn('mcp_servers', tomllib.loads(project.read_text()))
        self.assertEqual(tomllib.loads(project.read_text())['model'], 'test')
    def test_unapproved_repository_fails_before_checkout(self):
        self.settings['repository'] = {'url':'https://github.com/example/repo.git'}; self.save()
        with patch.object(bootstrap, 'checkout') as checkout:
            with self.assertRaises(ValueError): self.prepare()
            checkout.assert_not_called()
    def test_gateway_alias_is_trusted_once(self):
        repo = self.workspace / 'repository'; repo.mkdir(parents=True)
        self.settings = {'repository': {'url':'https://github.com/example/repo.git'}, 'trustRepository':True}; self.save()
        alias='/__paseo_kubernetes/gw-test/workspace'
        with patch.object(bootstrap, 'checkout', return_value=repo):
            bootstrap.prepare(self.workspace,self.secrets,self.config,'profile',alias)
        config=tomllib.loads((self.workspace / '.codex/config.toml').read_text())
        self.assertEqual(config['projects'][alias+'/repository']['trust_level'],'trusted')
    def test_serializer_preserves_nested_codex_configuration(self):
        data=tomllib.loads('model="test"\n[features]\nweb_search=true\n[[example]]\nname="a"\n')
        self.assertEqual(tomllib.loads(bootstrap.dump_toml(data)), data)
    def test_git_rejects_inline_credentials_and_option_revisions(self):
        for repo in [{'url':'https://secret@example.com/repo.git'}, {'url':'https://github.com/example/repo.git','revision':'--evil'}]:
            with self.assertRaises(ValueError): bootstrap.checkout(self.base, repo)

class ProviderSetTest(Base):
    def setUp(self):
        super().setUp()
        self.providers = self.base / 'providers'; self.providers.mkdir()
        self.pfiles = {'auth.json': json.dumps({'tokens': {'access_token': 'SHARED_AUTH'}}),
                       '.credentials.json': '{"mcp":"cache"}',
                       'config.toml': 'model = "shared"\ncli_auth_credentials_store = "file"\n'
                                      '[mcp_servers.docs]\nurl="https://shared.example/mcp"\n'
                                      '[mcp_servers.other]\nurl="https://other.example/mcp"\n'
                                      '[projects."/evil"]\ntrust_level="trusted"\n'}
        self.files = {'config.toml': 'model = "project"\n[mcp_servers.docs]\nurl="https://project.example/mcp"\n'}
        self.save()
    def save(self):
        super().save()
        if hasattr(self, 'providers'): (self.providers / 'files.json').write_text(json.dumps(self.pfiles))
    def prepare(self, profile='profile-v1', **kw):
        kw.setdefault('providers', 'set-v1')
        bootstrap.prepare(self.workspace, self.secrets, self.config, profile, None, providers_secret_dir=self.providers, **kw)
    def codex(self, name): return self.workspace / '.codex' / name
    def test_project_wins_over_provider_and_mcp_tables_merge_by_name(self):
        self.prepare()
        config = tomllib.loads(self.codex('config.toml').read_text())
        self.assertEqual(config['model'], 'project')
        self.assertEqual(config['cli_auth_credentials_store'], 'file')
        self.assertEqual(config['mcp_servers']['docs']['url'], 'https://project.example/mcp')
        self.assertEqual(config['mcp_servers']['other']['url'], 'https://other.example/mcp')
        self.assertNotIn('/evil', config.get('projects', {}))
        self.assertIn('SHARED_AUTH', self.codex('auth.json').read_text())
    def test_subset_filters_files_and_mcps(self):
        self.prepare(provider_files={'auth.json'}, provider_mcps=set())
        config = tomllib.loads(self.codex('config.toml').read_text())
        self.assertEqual(set(config['mcp_servers']), {'docs'})  # only the project's own
        self.assertTrue(self.codex('auth.json').exists())
        self.assertFalse(self.codex('.credentials.json').exists())
    def test_empty_subset_is_clone_only(self):
        self.prepare(provider_files=set(), provider_mcps=set())
        self.assertFalse(self.codex('auth.json').exists())
    def test_marker_covers_provider_set_and_refreshed_tokens_survive(self):
        self.prepare()
        self.assertEqual((self.workspace / '.paseo-bootstrap-profile').read_text(), 'profile-v1+set-v1')
        self.codex('auth.json').write_text('refreshed')
        self.prepare()
        self.assertEqual(self.codex('auth.json').read_text(), 'refreshed')
        self.prepare(providers='set-v2')
        self.assertIn('SHARED_AUTH', self.codex('auth.json').read_text())
    def test_provider_credentials_removed_when_set_stops_providing_them(self):
        self.prepare()
        del self.pfiles['.credentials.json']; self.save()
        self.prepare(providers='set-v2')
        self.assertFalse(self.codex('.credentials.json').exists())
    def test_unsafe_provider_files_rejected(self):
        self.pfiles['../stolen'] = 'PRIVATE'; self.save()
        with self.assertRaises(ValueError): self.prepare()
        del self.pfiles['../stolen']; self.pfiles['auth.json'] = 'not json'; self.save()
        with self.assertRaises(ValueError): self.prepare()
    def test_provider_symlink_destination_rejected(self):
        self.workspace.mkdir(exist_ok=True); (self.workspace / '.codex').mkdir(exist_ok=True)
        self.codex('auth.json').symlink_to(self.base / 'outside')
        with self.assertRaises(ValueError): self.prepare()
    def test_project_config_still_required(self):
        self.files = {}; self.save()
        with self.assertRaises(ValueError): self.prepare()
    def test_legacy_pod_ignores_provider_arguments(self):
        # No --providers: identical to the pre-provider behaviour, plain marker, no shared files.
        bootstrap.prepare(self.workspace, self.secrets, self.config, 'profile-v1')
        self.assertEqual((self.workspace / '.paseo-bootstrap-profile').read_text(), 'profile-v1')
        self.assertFalse(self.codex('auth.json').exists())

if __name__ == '__main__': unittest.main()
