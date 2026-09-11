#!/usr/bin/env python3
"""Trusted Actions-only durable archive branch transport; never force-push."""
import argparse
import base64
import os
from pathlib import Path
import re
import shutil
import subprocess
from build_site import BuildError, load_archive, MAX_SITE_BYTES, MAX_MONTH_BYTES

BRANCH = 'hydra-data'


def git(args, *, cwd=None, allowed=(0,)):
    token = os.environ.get('GITHUB_TOKEN', '')
    if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise BuildError('Missing or invalid archive publication token.')
    env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
    env.update({'GIT_CONFIG_COUNT':'1',
                'GIT_CONFIG_KEY_0':'http.https://github.com/.extraheader',
                'GIT_CONFIG_VALUE_0':'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:'+token).encode()).decode(),
                'GIT_TERMINAL_PROMPT':'0'})
    # No credential in argv, URL, persisted config or logged stdout/stderr.
    result = subprocess.run(['git','-c','credential.helper=','-c','http.followRedirects=false',*args],
                            cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode not in allowed:
        raise BuildError('Archive Git operation failed; no Pages publication.')
    return result


def prepare(state, remote):
    if state.exists():
        raise BuildError('Archive checkout directory already exists.')
    result = git(['ls-remote','--exit-code','--heads',remote,'refs/heads/'+BRANCH], allowed=(0,2))
    if result.returncode not in (0,2):
        raise BuildError('Cannot determine archive branch state.')
    state.mkdir(parents=True)
    git(['init','--initial-branch='+BRANCH], cwd=state)
    if result.returncode == 2:
        return False  # ONLY exit 2 means no matching ref; transport/auth errors abort.
    git(['fetch','--depth=1',remote,'refs/heads/'+BRANCH], cwd=state)
    git(['checkout','-B',BRANCH,'FETCH_HEAD'], cwd=state)
    return True


def commit_and_push(state, remote):
    git(['add','--all'], cwd=state)
    changed = git(['diff','--cached','--quiet'], cwd=state, allowed=(0,1))
    if changed.returncode == 0:
        return False
    git(['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com',
         'commit','-m','Update compact HIDRA archive'], cwd=state)
    git(['push',remote,'HEAD:refs/heads/'+BRANCH], cwd=state)
    expected = git(['rev-parse','HEAD'], cwd=state).stdout.strip()
    actual = git(['ls-remote','--exit-code','--heads',remote,'refs/heads/'+BRANCH], cwd=state).stdout.split()
    if not actual or actual[0] != expected:
        raise BuildError('Archive branch read-back did not match; stopping Pages publication.')
    return True


def publish(state, staged, remote):
    if not (state/'.git').is_dir() or state.is_symlink() or state.resolve() == staged.resolve():
        raise BuildError('Invalid archive checkout or staging directory.')
    # Validate again; copy only expected canonical files, never arbitrary staging contents.
    runs, gauges = load_archive(staged)
    from build_site import timestamp, month_path
    allowed = ['README.md','index.json']
    allowed += ['runs/'+month_path(m) for m in sorted({i[:6] for i in runs})]
    allowed += ['gauges/'+month_path(m) for m in sorted({timestamp(d).strftime('%Y%m') for d in gauges})]
    total = 0
    token = os.environ.get('GITHUB_TOKEN','').encode()
    for relative in allowed:
        path = staged/relative
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MONTH_BYTES:
            raise BuildError('Unsafe staged archive file.')
        body = path.read_bytes()
        if token and token in body:
            raise BuildError('Credential in staged archive; refusing publication.')
        total += len(body)
    if total > MAX_SITE_BYTES:
        raise BuildError('Archive exceeds size cap.')
    for child in state.iterdir():
        if child.name != '.git':
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
    for relative in allowed:
        target = state/relative
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(staged/relative,target)
    return commit_and_push(state,remote)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','publish'])
    parser.add_argument('--state',default='_archive-state')
    parser.add_argument('--staged',default='_archive-next')
    args=parser.parse_args()
    try:
        if os.environ.get('GITHUB_REF') != 'refs/heads/master' or os.environ.get('GITHUB_EVENT_NAME') not in ('push','schedule','workflow_dispatch'):
            raise BuildError('Archive writes are restricted to trusted master Actions runs.')
        repo=os.environ.get('GITHUB_REPOSITORY','')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo):
            raise BuildError('Invalid GitHub repository identifier.')
        remote='https://github.com/'+repo+'.git'
        if args.action == 'prepare':
            existing=prepare(Path(args.state),remote)
            with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as stream:
                stream.write('existing='+str(existing).lower()+'\n')
        else:
            publish(Path(args.state),Path(args.staged),remote)
    except BuildError as exc:
        parser.exit(1, str(exc)+'\n')
    except Exception:
        parser.exit(1,'Archive operation failed safely.\n')

if __name__ == '__main__':
    main()
