#!/usr/bin/env python3
"""Deploy only the existing Compose app; never migrate or restore its database."""

from contextlib import contextmanager
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen


CFG = Path('/root/manji-src/deploy/src')
PROJECT = 'manji-src'
APP = 'manji-src-app-1'
PG = 'manji-src-postgres-1'
GW = 'manji-src-gateway-1'
LOCK = Path('/run/lock/manji-cd.lock')
URL = 'https://manjilu.cn'
REPOSITORY = 'ghcr.io/qq2452180-oss/manji-test'
SOURCE = 'https://github.com/qq2452180-oss/manji-test'
MEDIA = '/app/data/media'
HEALTH_TIMEOUT = 120
HTTP_TIMEOUT = 120
COMMAND_TIMEOUT = 180
IMAGE_PATTERN = re.compile(re.escape(REPOSITORY) + r'@sha256:[0-9a-f]{64}\Z')
REVISION_PATTERN = re.compile(r'[0-9a-f]{40}\Z')
IMAGE_SETTING = re.compile(rb'(?m)^([ \t]*MANJI_APP_IMAGE[ \t]*=[ \t]*)([^\r\n]*)(\r?)$')


class DeploymentError(RuntimeError):
    """An operational message that is safe to send to the SSH client."""


def emit(stage, **fields):
    """An SSH disconnect must not turn a successful switch into a rollback."""
    data = (json.dumps({'stage': stage, **fields}, ensure_ascii=False) + '\n').encode()
    try:
        os.write(1, data)
    except OSError:
        pass


def run(arguments, *, env=None, timeout=COMMAND_TIMEOUT, operation='command'):
    try:
        result = subprocess.run(
            arguments, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise DeploymentError(operation + ' timed out') from None
    except OSError:
        raise DeploymentError(operation + ' could not start') from None
    if result.returncode:
        # Docker/Compose errors can include resolved environment variables.
        raise DeploymentError(operation + ' failed')
    return result.stdout


def docker(*arguments, timeout=COMMAND_TIMEOUT):
    return run(['docker', *arguments], timeout=timeout, operation='Docker operation')


def compose(*arguments, image=None):
    environment = os.environ.copy()
    environment.pop('MANJI_APP_IMAGE', None)
    if image is not None:
        environment['MANJI_APP_IMAGE'] = image
    return run(
        ['docker', 'compose', '--project-name', PROJECT,
         '--env-file', str(CFG / 'compose.env'), '-f', str(CFG / 'compose.yml'),
         *arguments], env=environment, operation='Compose operation',
    )


def configuration(image=None):
    try:
        return json.loads(compose('config', '--format', 'json', image=image))
    except (ValueError, TypeError):
        raise DeploymentError('Compose configuration could not be read') from None


def inspect(reference, *, image=False):
    arguments = ('image', 'inspect', reference) if image else ('inspect', reference)
    try:
        return json.loads(docker(*arguments))[0]
    except (ValueError, TypeError, IndexError):
        raise DeploymentError('Docker metadata could not be read') from None


def optional_container(name):
    try:
        return inspect(name)
    except DeploymentError:
        return None


def image_revision(info):
    value = (info['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')
    return value if isinstance(value, str) and REVISION_PATTERN.fullmatch(value) else None


def validate_image(info, revision=None, *, published=True):
    if info.get('Architecture') != 'amd64' or info.get('Os') != 'linux':
        raise DeploymentError('Image must target linux/amd64')
    if info['Config'].get('User') != '10001:10001':
        raise DeploymentError('Image must use the existing application UID/GID')
    if revision is not None and image_revision(info) != revision:
        raise DeploymentError('Image revision does not match the requested commit')
    if published and (info['Config'].get('Labels') or {}).get('org.opencontainers.image.source') != SOURCE:
        raise DeploymentError('Image source does not match this repository')


def pull_image(reference, revision):
    emit('pull', image=reference, revision=revision)
    docker('pull', reference, timeout=600)
    info = inspect(reference, image=True)
    validate_image(info, revision)
    return info


def record(reference, info):
    return {'image': reference, 'image_id': info['Id'], 'revision': image_revision(info)}


def load_state():
    path = CFG / 'cd-state.json'
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text())
        if state.get('version') != 1:
            raise ValueError
        for item in (state['current'], state.get('previous')):
            if item is None:
                continue
            if not isinstance(item['image'], str) or not isinstance(item['image_id'], str):
                raise ValueError
            if item.get('revision') is not None and not REVISION_PATTERN.fullmatch(item['revision']):
                raise ValueError
        return state
    except (OSError, ValueError, KeyError, TypeError):
        raise DeploymentError('Deployment state is invalid; review it on the server') from None


def atomic_write(path, contents, metadata=None):
    if path.is_symlink():
        raise DeploymentError('Refusing to replace a symbolic-link configuration file')
    if metadata is None and path.exists():
        metadata = path.stat()
    descriptor, temporary = tempfile.mkstemp(prefix='.manji-cd-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            if metadata is not None:
                os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
                current = os.fstat(output.fileno())
                if (current.st_uid, current.st_gid) != (metadata.st_uid, metadata.st_gid):
                    os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def replace_image(contents, reference):
    if len(list(IMAGE_SETTING.finditer(contents))) != 1:
        raise DeploymentError('compose.env must contain exactly one MANJI_APP_IMAGE assignment')
    return IMAGE_SETTING.sub(lambda match: match[1] + reference.encode('ascii') + match[3], contents)


def mount_signature(container):
    return sorted(
        (item['Type'], item.get('Name', ''), item['Source'], item['Destination'], bool(item['RW']))
        for item in container['Mounts']
    )


def check_environment(container, environment):
    actual = dict(item.split('=', 1) for item in container['Config']['Env'])
    if any(not isinstance(value, str) or actual.get(key) != value for key, value in environment.items()):
        raise DeploymentError('Application environment differs from Compose configuration')


def snapshot(*, require_healthy=True):
    path = CFG / 'compose.env'
    contents, metadata = path.read_bytes(), path.stat()
    config = configuration()
    app = inspect(APP)
    service = config['services']['app']
    if service['image'] != app['Config']['Image']:
        raise DeploymentError('Configured image differs from the running app; resolve deployment drift first')
    replace_image(contents, service['image'])
    check_environment(app, service.get('environment', {}))
    if require_healthy and (not app['State']['Running']
                            or app['State'].get('Health', {}).get('Status') != 'healthy'):
        raise DeploymentError('Current application is not healthy; automatic deployment is blocked')
    image = inspect(app['Image'], image=True)
    return {
        'contents': contents, 'metadata': metadata, 'config': config, 'app': app,
        'record': record(service['image'], image),
        'environment': service.get('environment', {}), 'mounts': mount_signature(app),
        'networks': set(app['NetworkSettings']['Networks']),
        'infrastructure': {name: inspect(name)['Id'] for name in (PG, GW)},
    }


def check_record(item, before):
    if item is None or any(item.get(key) != before['record'][key] for key in ('image', 'image_id')):
        raise DeploymentError('Recorded deployment differs from the live app; review server state')


def check_configuration(before, image=None):
    expected = deepcopy(before['config'])
    if image is not None:
        expected['services']['app']['image'] = image
    if configuration(image=image) != expected:
        raise DeploymentError('Compose settings changed beyond the application image')


def wait_healthy(name):
    deadline = time.monotonic() + HEALTH_TIMEOUT
    while time.monotonic() < deadline:
        state = inspect(name)['State']
        if not state['Running']:
            raise DeploymentError('Application container stopped before becoming healthy')
        if state.get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(2)
    raise DeploymentError('Application health check timed out')


def preflight(target, before):
    name = PROJECT + '-cd-check'
    if optional_container(name) is not None:
        raise DeploymentError('A previous candidate container exists; review it before deploying')
    check_configuration(before, target['image'])
    media = [item for item in before['app']['Mounts'] if item['Destination'] == MEDIA]
    if len(media) != 1 or media[0]['Type'] not in ('volume', 'bind'):
        raise DeploymentError('Existing media mount could not be identified')
    configured_media = [item for item in before['config']['services']['app'].get('volumes', [])
                        if item.get('target') == MEDIA]
    if len(configured_media) != 1:
        raise DeploymentError('Compose media mount could not be identified')
    read_only_media = deepcopy(configured_media[0])
    read_only_media['read_only'] = True
    descriptor, filename = tempfile.mkstemp(prefix='.manji-cd-candidate-', suffix='.json', dir=CFG)
    overlay = Path(filename)
    emit('preflight', image=target['image'])
    try:
        # Compose merges volume entries by target. Keep the logical source name
        # and existing top-level volume definition; write no environment values.
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'services': {'app': {'volumes': [read_only_media]}}}, output)
        # `compose run` has no --no-build option. The image was pulled above;
        # do not request --build, service ports, or production network aliases.
        compose('-f', str(overlay), 'run', '--no-deps', '--pull', 'never',
                '-d', '--name', name, 'app', image=target['image'])
        candidate = inspect(name)
        if candidate['Image'] != target['image_id']:
            raise DeploymentError('Candidate started with an unexpected image')
        check_environment(candidate, before['environment'])
        candidate_media = [item for item in candidate['Mounts'] if item['Destination'] == MEDIA]
        if len(candidate_media) != 1 or candidate_media[0]['RW']:
            raise DeploymentError('Candidate media mount is not read-only')
        if any(candidate_media[0].get(key) != media[0].get(key)
               for key in ('Type', 'Name', 'Source', 'Destination')):
            raise DeploymentError('Candidate media mount differs from the existing app')
        if any(candidate['NetworkSettings'].get('Ports', {}).values()):
            raise DeploymentError('Candidate unexpectedly published host ports')
        # This command performs only schema/history reads; no init or migrate.
        docker('exec', name, 'python', '-m', 'src.common.migrate', 'check')
        wait_healthy(name)
    finally:
        try:
            candidate = optional_container(name)
            if candidate is not None:
                labels = candidate['Config'].get('Labels') or {}
                if (candidate['Image'] != target['image_id']
                        or labels.get('com.docker.compose.project') != PROJECT
                        or labels.get('com.docker.compose.service') != 'app'
                        or labels.get('com.docker.compose.oneoff', '').lower() != 'true'):
                    raise DeploymentError('Candidate ownership changed; refusing to remove it')
                docker('rm', '-f', name)
        finally:
            overlay.unlink(missing_ok=True)


def check_public():
    deadline = time.monotonic() + HTTP_TIMEOUT
    while time.monotonic() < deadline:
        try:
            with urlopen(URL.rstrip('/') + '/api/ready', timeout=8) as response:
                if response.status != 200 or json.load(response).get('status') != 'ready':
                    raise ValueError
            with urlopen(URL.rstrip('/') + '/web/index.html', timeout=8) as response:
                if response.status != 200 or not response.read(1):
                    raise ValueError
            return
        except (OSError, URLError, ValueError, TypeError, AttributeError):
            time.sleep(2)
    raise DeploymentError('Gateway HTTPS readiness or page verification timed out')


def verify_running(target, before):
    wait_healthy(APP)
    app = inspect(APP)
    if app['Image'] != target['image_id'] or app['Config']['Image'] != target['image']:
        raise DeploymentError('Running application image is not the expected image')
    check_environment(app, before['environment'])
    if mount_signature(app) != before['mounts']:
        raise DeploymentError('Application mounts changed')
    if set(app['NetworkSettings']['Networks']) != before['networks']:
        raise DeploymentError('Application networks changed')
    if any(inspect(name)['Id'] != identifier for name, identifier in before['infrastructure'].items()):
        raise DeploymentError('Database or gateway container changed')
    check_public()


def switch(target, before, previous_state):
    path, state_path = CFG / 'compose.env', CFG / 'cd-state.json'
    if path.read_bytes() != before['contents']:
        raise DeploymentError('compose.env changed during preflight')
    check_configuration(before)
    if inspect(APP)['Id'] != before['app']['Id']:
        raise DeploymentError('Application changed during preflight')
    updated = replace_image(before['contents'], target['image'])
    attempted = False
    try:
        emit('switch', image=target['image'], revision=target.get('revision'))
        attempted = True
        atomic_write(path, updated, before['metadata'])
        check_configuration(before, target['image'])
        compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app')
        verify_running(target, before)
        state = {'version': 1, 'current': target, 'previous': before['record']}
        atomic_write(state_path, (json.dumps(state, indent=2) + '\n').encode())
        emit('deployed', image=target['image'], revision=target.get('revision'))
    except BaseException:
        if attempted:
            emit('rollback_started', image=before['record']['image'])
            try:
                if path.read_bytes() not in (before['contents'], updated):
                    raise DeploymentError('compose.env changed outside this deployment')
                old = inspect(before['record']['image'], image=True)
                if old['Id'] != before['record']['image_id']:
                    raise DeploymentError('Previous image reference changed; automatic rollback is blocked')
                atomic_write(path, before['contents'], before['metadata'])
                compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app')
                verify_running(before['record'], before)
                if previous_state is not None:
                    atomic_write(state_path, (json.dumps(previous_state, indent=2) + '\n').encode())
                elif state_path.exists():
                    state_path.unlink()
                emit('rollback_succeeded', image=before['record']['image'])
            except BaseException:
                emit('rollback_failed', image=before['record']['image'])
                raise DeploymentError('Deployment failed and rollback could not be verified; inspect the server') from None
        raise DeploymentError('Deployment failed; the previous application was restored') from None


def deploy(reference, revision):
    before, state = snapshot(), load_state()
    if state is not None:
        check_record(state['current'], before)
    info = pull_image(reference, revision)
    target = record(reference, info)
    if target == before['record']:
        emit('unchanged', image=reference, revision=revision)
        return
    preflight(target, before)
    switch(target, before, state)


def rollback():
    before, state = snapshot(require_healthy=False), load_state()
    if state is None or state.get('previous') is None:
        raise DeploymentError('No previous deployment is recorded')
    check_record(state['current'], before)
    target = state['previous']
    info = inspect(target['image'], image=True)
    if info['Id'] != target['image_id']:
        raise DeploymentError('Previous image is missing or its reference changed')
    # The first previous image can be the legacy, locally-built production image.
    validate_image(info, target.get('revision'), published=False)
    preflight(target, before)
    switch(target, before, state)


def status():
    state, app, config = load_state(), inspect(APP), configuration()
    actual = {'image': app['Config']['Image'], 'image_id': app['Image'],
              'revision': image_revision(app)}
    emit('status', running=actual, healthy=app['State'].get('Health', {}).get('Status') == 'healthy',
         configured_image=config['services']['app']['image'], recorded=state,
         drift=(config['services']['app']['image'] != actual['image']
                or (state is not None and any(state['current'].get(key) != actual[key]
                                              for key in ('image', 'image_id')))))


@contextmanager
def deployment_lock():
    descriptor = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError('Another deployment is already running') from None
        yield
    finally:
        os.close(descriptor)


def parse_command(arguments):
    if 'SSH_ORIGINAL_COMMAND' in os.environ:
        if arguments:
            raise DeploymentError('Forced-command arguments are not permitted')
        original = os.environ['SSH_ORIGINAL_COMMAND']
        if len(original) > 1024 or '\x00' in original:
            raise DeploymentError('Unsupported deployment command')
        try:
            arguments = shlex.split(original)
        except ValueError:
            raise DeploymentError('Unsupported deployment command') from None
    if arguments in (['rollback'], ['status']):
        return arguments
    if (len(arguments) == 3 and arguments[0] == 'deploy'
            and IMAGE_PATTERN.fullmatch(arguments[1]) and REVISION_PATTERN.fullmatch(arguments[2])):
        return arguments
    raise DeploymentError('Allowed commands: deploy <repository@sha256:digest> <revision>, rollback, status')


def main(arguments=None):
    os.umask(0o077)
    # Preserve the transaction when the SSH client closes its connection.
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        command = parse_command(list(sys.argv[1:] if arguments is None else arguments))
        with deployment_lock():
            if command[0] == 'deploy':
                deploy(command[1], command[2])
            elif command[0] == 'rollback':
                rollback()
            else:
                status()
        return 0
    except DeploymentError as error:
        emit('error', message=str(error))
    except (Exception, KeyboardInterrupt):
        # Do not expose traceback locals, Docker output, URLs, or configuration.
        emit('error', message='Deployment operation failed; inspect the server state')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
