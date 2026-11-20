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

class BootstrapTest(unittest.TestCase):
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

if __name__ == '__main__': unittest.main()
