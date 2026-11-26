#!/usr/bin/env python3
"""Local tests, Docker packaging and restricted SSH deployment; no registry required."""

import argparse
from contextlib import contextmanager
import fcntl
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

from image_archive import SOURCE, digest_file, inspect_archive


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / 'deploy' / 'production'
WORK = ROOT / '.release'
KEY = Path.home() / '.ssh' / 'manji_release_ed25519'
POSTGRES = 'postgres:18.6'


def configure_docker_path():
    # Some macOS shells find `docker` through a symlink but not its credential helper.
    desktop = Path('/Applications/Docker.app/Contents/Resources/bin')
    if desktop.is_dir():
        os.environ['PATH'] = os.environ.get('PATH', '') + os.pathsep + str(desktop)


def run(arguments, *, cwd=ROOT, capture=False, **kwargs):
    result = subprocess.run([str(item) for item in arguments], cwd=cwd,
                            stdout=subprocess.PIPE if capture else None,
                            text=True, check=True, **kwargs)
    return result.stdout.strip() if capture else None


def step(message):
    print('\n>>> ' + message, flush=True)


@contextmanager
def local_lock(enabled):
    if not enabled:
        yield
        return
    with (WORK / 'command.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('另一个本地测试或打包命令正在运行，请等待它完成。') from None
        yield


def python_for_tests():
    candidates = [os.environ.get('MANJI_PYTHON'), shutil.which('python3.11'),
                  '/opt/anaconda3/envs/manji/bin/python', sys.executable]
    for candidate in filter(None, candidates):
        if Path(candidate).is_file():
            version = run([candidate, '-c', 'import sys; print("%s.%s" % sys.version_info[:2])'], capture=True)
            if version == '3.11':
                return candidate
        if os.environ.get('MANJI_PYTHON') == candidate:
            break
    raise ValueError('需要 Python 3.11；用 MANJI_PYTHON=/path/to/python3.11 指定解释器。')


def ensure_postgres():
    found = subprocess.run(['docker', 'image', 'inspect', POSTGRES],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if found.returncode:
        run(['docker', 'pull', '--platform', 'linux/amd64', POSTGRES])


def checks(source):
    step('前端依赖、测试和构建')
    version = run(['node', '-p', 'process.versions.node'], capture=True)
    if tuple(map(int, version.split('.'))) < (24, 12, 0):
        raise ValueError('需要 Node.js >= 24.12。')
    for arguments in (['npm', 'ci'], ['npm', 'test'], ['npm', 'run', 'build']):
        run(arguments, cwd=source / 'src' / 'web')

    step('隔离 Python 环境和后端测试数据库')
    interpreter = python_for_tests()
    environment = WORK / 'venv'
    if not (environment / 'bin' / 'python').is_file():
        run([interpreter, '-m', 'venv', environment])
    python = environment / 'bin' / 'python'
    run([python, '-m', 'pip', 'install', '--disable-pip-version-check', '-r', source / 'requirements-dev.txt'])
    run([python, '-m', 'pip', 'check'])
    ensure_postgres()
    name = 'manji-local-test-' + uuid.uuid4().hex[:12]
    password = uuid.uuid4().hex
    try:
        run(['docker', 'run', '-d', '--pull', 'never', '--platform', 'linux/amd64',
             '--name', name, '--publish', '127.0.0.1::5432',
             '--tmpfs', '/var/lib/postgresql:rw,size=256m',
             '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=manji_local_test', POSTGRES], capture=True)
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1',
                                    '-U', 'postgres', '-d', 'manji_local_test'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise ValueError('临时 PostgreSQL 启动超时。')
        info = json.loads(run(['docker', 'inspect', name], capture=True))[0]
        port = info['NetworkSettings']['Ports']['5432/tcp'][0]['HostPort']
        env = os.environ.copy()
        env['MANJILU_TEST_DATABASE_URL'] = f'postgresql://postgres:{password}@127.0.0.1:{port}/manji_local_test'
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        run([python, '-m', 'pytest', 'src/tests', '-q', '-rs'], cwd=source, env=env)
        if (source / 'deploy/production/tests').is_dir():
            run([python, '-m', 'unittest', 'discover', '-s', 'deploy/production/tests', '-v'], cwd=source)
    finally:
        cleanup = subprocess.run(['docker', 'rm', '-fv', name], text=True, capture_output=True)
        if cleanup.returncode and 'No such container' not in cleanup.stderr:
            print('临时测试容器清理失败，请检查：' + name, file=sys.stderr)
            if sys.exc_info()[0] is None:
                raise ValueError('测试容器未能清理。')


def package(revision=None):
    if revision is None and run(['git', 'status', '--porcelain', '--untracked-files=normal'], capture=True):
        raise ValueError('请先 git add / git commit 保存本次修改（不必 push）。也可用 --revision 明确打包已提交版本。')
    revision = run(['git', 'rev-parse', '--verify', (revision or 'HEAD') + '^{commit}'], capture=True)
    release_id = revision + '-' + uuid.uuid4().hex[:12]
    reference = 'manji-local:' + release_id
    destination = WORK / 'packages' / release_id
    destination.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='source-', dir=WORK) as temporary:
        temporary = Path(temporary)
        source = temporary / 'source'
        source.mkdir()
        run(['git', 'archive', '--format=tar', '--output', temporary / 'source.tar', revision])
        run(['tar', '-xf', temporary / 'source.tar', '-C', source])
        step('测试已提交版本 ' + revision)
        checks(source)
        step('构建 linux/amd64 镜像并直接导出完整归档')
        archive = destination / 'image.tar'
        run(['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--provenance=false',
             '--label', 'org.opencontainers.image.source=' + SOURCE,
             '--label', 'org.opencontainers.image.revision=' + revision,
             '--tag', reference, '--output', 'type=docker,dest=' + str(archive),
             '--progress', 'plain', '.'], cwd=source)
        metadata = inspect_archive(archive, reference, revision)
        step('导入归档并检查真实镜像启动、页面、数据库和媒体存储')
        run(['docker', 'load', '--input', archive])
        info = json.loads(run(['docker', 'image', 'inspect', reference], capture=True))[0]
        if info['RootFS']['Layers'] != metadata['layers']:
            raise ValueError('本地导入的镜像层与归档不一致。')
        run([sys.executable, source / 'scripts/ci/smoke_image.py', reference])
        step('压缩发布包')
        compressed = destination / 'image.tar.gz'
        with archive.open('rb') as original, compressed.open('wb') as output:
            with gzip.GzipFile(fileobj=output, mode='wb', compresslevel=6, mtime=0) as zipped:
                shutil.copyfileobj(original, zipped)
        inspect_archive(compressed, reference, revision, metadata['image_id'])
        manifest = {
            'version': 1, 'revision': revision, 'image': reference,
            'image_id': metadata['image_id'], 'archive': compressed.name,
            'sha256': digest_file(compressed), 'size': compressed.stat().st_size,
        }
        manifest_path = destination / 'release.json'
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        archive.unlink()
    (WORK / 'latest').write_text(str(manifest_path) + '\n')
    step('发布包已通过全部检查：' + str(manifest_path))
    return manifest_path


def read_manifest(filename=None):
    if filename is None:
        latest = WORK / 'latest'
        if not latest.is_file():
            raise ValueError('尚无发布包；先执行 ./deploy.sh package。')
        filename = latest.read_text().strip()
    path = Path(filename).resolve()
    manifest = json.loads(path.read_text())
    if (not isinstance(manifest, dict)
            or any(not isinstance(manifest.get(key), str) for key in ('revision', 'sha256', 'image_id', 'image'))
            or manifest.get('version') != 1 or manifest.get('archive') != 'image.tar.gz'
            or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('revision', ''))
            or not re.fullmatch(r'[0-9a-f]{64}', manifest.get('sha256', ''))
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', manifest.get('image_id', ''))
            or not re.fullmatch('manji-local:' + manifest['revision'] + r'-[0-9a-f]{12}', manifest.get('image', ''))
            or not isinstance(manifest.get('size'), int) or not 0 < manifest['size'] <= 2 * 1024 ** 3):
        raise ValueError('发布清单格式不正确。')
    archive = path.parent / manifest['archive']
    if archive.stat().st_size != manifest['size'] or digest_file(archive) != manifest['sha256']:
        raise ValueError('发布包大小或 SHA256 不匹配；请重新打包。')
    return manifest, archive


def ssh(arguments, command, **kwargs):
    key = Path(arguments.key).expanduser()
    if not key.is_file():
        raise ValueError('发布密钥不存在；先执行 ./deploy.sh init 并安装服务器初始化包。')
    return run(['ssh', '-T', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(TOOLS / 'known_hosts'),
                '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8',
                'root@152.136.149.132', command], **kwargs)


def upload(arguments, manifest, archive):
    step('上传镜像包：%.1f MiB；期间线上旧版本继续运行' % (manifest['size'] / 1024 ** 2))
    for attempt in range(3):
        try:
            with archive.open('rb') as stream:
                ssh(arguments, 'upload %s %s' % (manifest['sha256'], manifest['size']), stdin=stream)
            return
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            print('上传失败，重新上传（%s/3）…' % (attempt + 2), flush=True)
            time.sleep(2)


def verify_server(arguments):
    output = ssh(arguments, 'status', capture=True)
    print(output, flush=True)
    try:
        status = json.loads(output)
    except (ValueError, TypeError):
        raise ValueError('无法读取服务器发布工具状态。') from None
    if not isinstance(status, dict) or status.get('database_migrations') is not True:
        raise ValueError('服务器部署脚本尚不支持自动数据库迁移。请先执行 ./deploy.sh init，'
                         '上传新安装包并在服务器运行 install-server.sh，再重新发布。')


def deploy_package(arguments, filename=None):
    manifest, archive = read_manifest(filename)
    # Check authentication before transferring a potentially large package.
    verify_server(arguments)
    if not arguments.uploaded:
        upload(arguments, manifest, archive)
    step('服务器导入镜像、数据库备份与增量迁移、上线检查、切换和健康验证')
    ssh(arguments, 'deploy-local {sha256} {image} {revision} {image_id}'.format(**manifest))
    ssh(arguments, 'status')


def initialize(arguments):
    key = Path(arguments.key).expanduser().resolve()
    key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not key.exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'manji-local-release', '-f', key])
    public = Path(str(key) + '.pub')
    if not public.is_file():
        raise ValueError('缺少对应 .pub 公钥，请使用一个完整的专用密钥对。')
    destination = WORK / 'server-setup.tar.gz'
    with tarfile.open(destination, 'w:gz') as archive:
        for name in ('deploy.py', 'image_archive.py', 'database_backup.py', 'install-server.sh'):
            archive.add(TOOLS / name, arcname='manji-release-setup/' + name)
        archive.add(public, arcname='manji-release-setup/release-key.pub')
    step('服务器安装/更新包：' + str(destination))
    print('把该文件上传到服务器 /root，然后在服务器终端执行：\n'
          'cd /root && tar -xzf server-setup.tar.gz && bash manji-release-setup/install-server.sh\n'
          '首次配置和更新部署脚本都需要安装该包；普通发布不会更新服务器部署脚本。\n'
          '完成后回到本机执行：./deploy.sh status\n'
          '私钥只保存在本机：' + str(key))


def choose_command():
    print('\n漫记发布工具（在 Mac 上操作）\n'
          '\n第一次使用：选 4，按提示完成服务器配置。\n'
          '平时更新网站：先将代码 git commit 保存到本地，再选 1。\n'
          '\n  1. 发布新版网站（测试 → 打包 → 上传 → 数据库升级 → 更新应用）\n'
          '  2. 查看线上版本和运行状态\n'
          '  3. 将线上应用恢复到上一版\n'
          '  4. 首次配置 / 更新部署脚本：生成服务器安装包\n'
          '  0. 退出\n')
    if not sys.stdin.isatty():
        print('在终端运行 ./deploy.sh 后输入数字选择；查看完整命令用 ./deploy.sh --help。')
        return None
    choices = {'1': 'publish', '2': 'status', '3': 'rollback', '4': 'init'}
    while True:
        try:
            choice = input('请选择 [0–4，直接回车退出]：').strip()
        except EOFError:
            return None
        if choice in ('', '0'):
            return None
        if choice in choices:
            return choices[choice]
        print('请输入 0、1、2、3 或 4。')


def main():
    parser = argparse.ArgumentParser(description='本地测试、打包、SSH 上传及部署；无需 GitHub Actions 或镜像仓库。')
    parser.add_argument('--key', default=str(KEY), help='专用发布 SSH 私钥路径')
    commands = parser.add_subparsers(dest='command')
    commands.add_parser('init', help='生成专用密钥及服务器安装/更新包')
    commands.add_parser('check', help='检查当前工作区：前端、后端及临时数据库测试')
    for name in ('package', 'publish'):
        child = commands.add_parser(name, help='测试并打包' if name == 'package' else '测试、打包、上传并部署')
        child.add_argument('--revision', help='明确指定已提交版本；默认要求工作区干净并打包 HEAD')
        child.set_defaults(uploaded=False)
    for name in ('upload', 'deploy'):
        child = commands.add_parser(name, help='只上传发布包' if name == 'upload' else '上传并部署发布包')
        child.add_argument('manifest', nargs='?', help='release.json 路径；默认最近成功打包的版本')
        if name == 'deploy':
            child.add_argument('--uploaded', action='store_true', help='跳过上传，使用服务器已收到的同一发布包')
    commands.add_parser('status', help='查看服务器版本及健康状态')
    commands.add_parser('rollback', help='回滚到服务器记录的上一版本')
    arguments = parser.parse_args()
    if arguments.command is None:
        try:
            arguments.command = choose_command()
        except KeyboardInterrupt:
            print('\n已退出。')
            return 130
        if arguments.command is None:
            return 0
        arguments.revision = None
        arguments.uploaded = False
    configure_docker_path()
    WORK.mkdir(exist_ok=True)
    try:
        with local_lock(arguments.command in ('init', 'check', 'package', 'publish')):
            if arguments.command == 'init':
                initialize(arguments)
            elif arguments.command == 'check':
                checks(ROOT)
            elif arguments.command == 'package':
                package(arguments.revision)
            elif arguments.command == 'publish':
                verify_server(arguments)
                deploy_package(arguments, package(arguments.revision))
            elif arguments.command == 'upload':
                manifest, archive = read_manifest(arguments.manifest)
                upload(arguments, manifest, archive)
            elif arguments.command == 'deploy':
                deploy_package(arguments, arguments.manifest)
            else:
                ssh(arguments, arguments.command)
        return 0
    except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print('\n失败：' + str(error), file=sys.stderr)
        if arguments.command in ('publish', 'deploy', 'rollback'):
            print('若部署期间 SSH 断开，请先运行 ./deploy.sh status 核对实际版本。', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\n已停止本地命令。若服务器已经开始切换，请用 ./deploy.sh status 核对结果。', file=sys.stderr)
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
