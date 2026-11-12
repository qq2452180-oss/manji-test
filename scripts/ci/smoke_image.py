"""Check a built image using disposable Docker resources and no production secrets."""

import argparse
import json
import subprocess
import sys
import time
import uuid


def docker(*args, check=True):
    result = subprocess.run(
        ["docker", *args], text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=120,
    )
    if check and result.returncode:
        raise RuntimeError(result.stdout)
    return result


FILES_CHECK = """
import os
from pathlib import Path
from src.main import app
from src.common.migrate import load_migrations
root = Path('/app')
assert os.getuid() == 10001
assert not list(root.rglob('.env*'))
assert not (root / '.git').exists()
assert not (root / 'src/web/node_modules').exists()
assert not (root / 'src/tests').exists()
assert load_migrations()
assert (root / 'src/web/dist/index.html').is_file()
print('Runtime imports, SQL, frontend, and secret-file exclusions: OK')
"""

HTTP_CHECK = """
import json
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urljoin, urlsplit
from src.api.health import _PageAssets
base = 'http://127.0.0.1:8000'
for path, expected in [('/api/health', 'ok'), ('/api/ready', 'ready')]:
    with urlopen(base + path, timeout=8) as response:
        assert response.status == 200
        assert json.load(response)['status'] == expected
root = Path('/app/src/web/dist')
pages = list(root.glob('*.html'))
assert pages
assets = set()
for page in pages:
    with urlopen(base + '/web/' + page.name, timeout=8) as response:
        assert response.status == 200
        parser = _PageAssets()
        parser.feed(response.read().decode())
        for url in parser.urls:
            if not urlsplit(url).netloc and not urlsplit(url).scheme:
                assets.add(urljoin(base + '/web/' + page.name, url))
for resource in root.rglob('*'):
    if resource.is_file() and resource.suffix != '.html':
        assets.add(base + '/web/' + resource.relative_to(root).as_posix())
for url in sorted(assets):
    with urlopen(url, timeout=8) as response:
        assert response.status == 200 and response.read()
print(json.dumps({'health': 'ok', 'ready': 'ready', 'pages': len(pages), 'assets': len(assets)}))
"""

MEDIA_CHECK = """
import stat
from pathlib import Path
from src.service.media.storage import LocalMediaStorage
root = Path('/app/data/media/files')
storage = LocalMediaStorage(root)
key = '0' * 32 + '.png'
storage.save(key, b'ci-smoke')
assert storage.read(key) == b'ci-smoke'
storage.delete(key)
assert not (root / key).exists()
assert root.stat().st_uid == 10001
assert stat.S_IMODE(root.stat().st_mode) == 0o700
print('Media volume write/read/delete as non-root: OK')
"""


def smoke(image, postgres_image):
    prefix = 'manji-ci-smoke-' + uuid.uuid4().hex[:10]
    network, database, app, media = (prefix + suffix for suffix in ('-net', '-pg', '-app', '-media'))
    dsn = 'postgresql://postgres:ci-only-password@db:5432/manji_smoke_test'
    created = []
    try:
        info = json.loads(docker('image', 'inspect', image).stdout)[0]
        assert info['Architecture'] == 'amd64'
        assert info['Config']['User'] == '10001:10001'
        image = info['Id']
        print('Image architecture/user: amd64 / 10001:10001', flush=True)
        for command in [('python', '-m', 'pip', 'check'), ('python', '-c', FILES_CHECK)]:
            result = docker('run', '--rm', '--platform', 'linux/amd64', '--network', 'none', image, *command)
            print(result.stdout.strip(), flush=True)

        created.append(('network', network))
        docker('network', 'create', '--internal', network)
        created.append(('volume', media))
        docker('volume', 'create', media)
        created.append(('container', database))
        docker(
            'run', '-d', '--pull', 'never', '--platform', 'linux/amd64',
            '--name', database, '--network', network, '--network-alias', 'db',
            '--tmpfs', '/var/lib/postgresql:rw,size=256m',
            '-e', 'POSTGRES_PASSWORD=ci-only-password', '-e', 'POSTGRES_DB=manji_smoke_test',
            postgres_image,
        )
        for _ in range(60):
            if docker('exec', database, 'pg_isready', '-U', 'postgres', '-d', 'manji_smoke_test', check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Temporary PostgreSQL startup timed out')

        for command in ('init', 'check'):
            result = docker(
                'run', '--rm', '--platform', 'linux/amd64', '--network', network,
                '-e', 'MANJILU_DATABASE_URL=' + dsn, image,
                'python', '-m', 'src.common.migrate', command,
            )
            print(result.stdout.strip(), flush=True)
        created.append(('container', app))
        docker(
            'run', '-d', '--platform', 'linux/amd64', '--name', app, '--network', network,
            '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m',
            '--mount', 'type=volume,source=' + media + ',target=/app/data/media',
            '-e', 'MANJILU_DATABASE_URL=' + dsn, '-e', 'MANJI_LANGGRAPH_RTC_ENABLED=false', image,
        )
        for _ in range(90):
            state = json.loads(docker('inspect', app).stdout)[0]['State']
            if not state['Running']:
                raise RuntimeError('App stopped: ' + docker('logs', app).stdout)
            if state.get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('App health timeout: ' + docker('logs', app).stdout)
        for check in (HTTP_CHECK, MEDIA_CHECK):
            print(docker('exec', app, 'python', '-c', check).stdout.strip(), flush=True)
        print('SMOKE PASSED', flush=True)
    finally:
        cleanup_errors = []
        for kind, name in reversed(created):
            args = ('rm', '-fv', name) if kind == 'container' else (kind, 'rm', name)
            try:
                result = docker(*args, check=False)
                missing = 'no such ' + kind
                if result.returncode and missing not in result.stdout.lower():
                    cleanup_errors.append(f'{kind} {name}: {result.stdout}')
            except (OSError, subprocess.TimeoutExpired) as error:
                cleanup_errors.append(f'{kind} {name}: {error}')
        if cleanup_errors:
            message = '\n'.join(cleanup_errors)
            if sys.exc_info()[0] is None:
                raise RuntimeError('Smoke cleanup failed: ' + message)
            print('Smoke cleanup failed: ' + message, file=sys.stderr)
        else:
            print('Temporary smoke resources cleaned up', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    parser.add_argument('--postgres-image', default='postgres:18.6')
    args = parser.parse_args()
    smoke(args.image, args.postgres_image)
