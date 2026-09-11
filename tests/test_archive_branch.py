"""Mock Git transport: branch absence is not a network failure; publication is nonforce."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))

class ArchiveGitTests(unittest.TestCase):
    def module(self):
        self.assertTrue((ROOT/'scripts/archive_branch.py').is_file(), 'archive publisher missing')
        spec=importlib.util.spec_from_file_location('archive_branch', ROOT/'scripts/archive_branch.py')
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_missing_branch_bootstraps_but_transport_failure_aborts(self):
        module=self.module()
        for status in [2,128]:
            with tempfile.TemporaryDirectory() as tmp:
                calls=[]
                def git(args, **kwargs):
                    calls.append(args)
                    return subprocess.CompletedProcess(args,status if 'ls-remote' in args else 0,stdout='')
                with patch.object(module,'git',side_effect=git):
                    if status==2:
                        self.assertFalse(module.prepare(Path(tmp)/'state','https://github.com/owner/repo.git'))
                        self.assertFalse(any('fetch' in c for c in calls))
                    else:
                        with self.assertRaises(module.BuildError): module.prepare(Path(tmp)/'state','https://github.com/owner/repo.git')
                        self.assertFalse(any('checkout' in c for c in calls))

    def test_existing_branch_is_fetched_and_auth_not_in_command(self):
        module=self.module()
        calls=[]
        def run(args, **kwargs):
            calls.append((args,kwargs))
            return subprocess.CompletedProcess(args,0,stdout='abc\trefs/heads/hydra-data\n')
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'GITHUB_TOKEN':'FAKE_TOKEN'}), patch.object(subprocess,'run',side_effect=run):
            self.assertTrue(module.prepare(Path(tmp)/'state','https://github.com/owner/repo.git'))
        self.assertTrue(any('fetch' in c for c,k in calls))
        self.assertTrue(all('FAKE_TOKEN' not in ' '.join(c) for c,k in calls))
        self.assertTrue(all(k['env']['GIT_CONFIG_COUNT']=='1' for c,k in calls))

    def test_unchanged_does_not_commit_changed_pushes_nonforce(self):
        module=self.module()
        for changed in [False,True]:
            calls=[]
            def git(args,**kwargs):
                calls.append(args)
                status=1 if changed and 'diff' in args else 0
                return subprocess.CompletedProcess(args,status,stdout='abc\trefs/heads/hydra-data\n' if 'ls-remote' in args else 'abc\n')
            with patch.object(module,'git',side_effect=git):
                module.commit_and_push(Path('/unused'), 'https://github.com/owner/repo.git')
            self.assertEqual(any('commit' in c for c in calls),changed)
            pushes=[c for c in calls if 'push' in c]
            self.assertEqual(len(pushes),int(changed))
            if pushes:
                self.assertEqual(pushes[0][-1],'HEAD:refs/heads/hydra-data')
                self.assertNotIn('--force',pushes[0])
                self.assertTrue(any('ls-remote' in c for c in calls),'read back pushed branch')

if __name__=='__main__':unittest.main()
