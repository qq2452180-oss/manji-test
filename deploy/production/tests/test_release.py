import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy
from image_archive import SOURCE, digest_file, inspect_archive
import release

REVISION = 'a' * 40
REFERENCE = 'manji-local:' + REVISION + '-123456789abc'


def make_archive(path, *, missing=False, damaged=False):
    layer = b'a complete base layer'
    config = json.dumps({
        'architecture': 'amd64', 'os': 'linux',
        'config': {'User': '10001:10001', 'Labels': {
            'org.opencontainers.image.revision': REVISION,
            'org.opencontainers.image.source': SOURCE,
        }},
        'rootfs': {'diff_ids': ['sha256:' + hashlib.sha256(layer).hexdigest()]},
    }).encode()
    manifest = [{'Config': 'config.json', 'RepoTags': [REFERENCE], 'Layers': ['base/layer.tar']}]
    contents = {'manifest.json': json.dumps(manifest).encode(), 'config.json': config}
    if not missing:
        contents['base/layer.tar'] = b'corrupt' if damaged else layer
    with tarfile.open(path, 'w:gz') as archive:
        for name, data in contents.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return 'sha256:' + hashlib.sha256(config).hexdigest()


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / 'image.tar.gz'

    def test_full_archive_validates_config_and_layers(self):
        image_id = make_archive(self.archive)
        self.assertEqual(inspect_archive(self.archive, REFERENCE, REVISION)['image_id'], image_id)

    def test_missing_cached_base_layer_is_rejected(self):
        make_archive(self.archive, missing=True)
        with self.assertRaises(KeyError):
            inspect_archive(self.archive, REFERENCE, REVISION)

    def test_corrupt_layer_is_rejected(self):
        make_archive(self.archive, damaged=True)
        with self.assertRaisesRegex(ValueError, 'damaged image layer'):
            inspect_archive(self.archive, REFERENCE, REVISION)

    def test_different_revision_or_image_id_is_rejected(self):
        make_archive(self.archive)
        with self.assertRaises(ValueError):
            inspect_archive(self.archive, REFERENCE, 'b' * 40)
        with self.assertRaises(ValueError):
            inspect_archive(self.archive, REFERENCE, REVISION, 'sha256:' + '0' * 64)

    def test_interrupted_or_corrupt_upload_leaves_no_release(self):
        complete = b'release package'
        checksum = hashlib.sha256(complete).hexdigest()
        for data in (complete[:-1], b'x' * len(complete), complete + b'extra'):
            with self.subTest(data=data), patch.object(deploy, 'PACKAGES', self.root):
                with patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(data))):
                    with self.assertRaises(deploy.DeploymentError):
                        deploy.receive_package(checksum, len(complete))
                self.assertEqual(list(self.root.iterdir()), [])

    def test_successful_upload_is_published_atomically(self):
        data = b'complete uploaded archive'
        checksum = hashlib.sha256(data).hexdigest()
        with patch.object(deploy, 'PACKAGES', self.root), patch.object(deploy, 'emit'):
            with patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(data))):
                deploy.receive_package(checksum, len(data))
        self.assertEqual((self.root / (checksum + '.tar.gz')).read_bytes(), data)

    def test_restricted_key_rejects_shell_commands_and_oversized_uploads(self):
        for command in ('sh', 'scp -t /root', 'status; touch /tmp/injected',
                        'upload ' + '0' * 64 + ' 999999999999',
                        'deploy-local ' + '0' * 64 + ' arbitrary:latest ' + REVISION + ' sha256:' + '0' * 64):
            with self.subTest(command=command), patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}):
                with self.assertRaises(deploy.DeploymentError):
                    deploy.parse_command([])

    def test_bad_archive_never_reaches_docker_load(self):
        image_id = make_archive(self.archive, damaged=True)
        checksum = digest_file(self.archive)
        self.archive.rename(self.root / (checksum + '.tar.gz'))
        with patch.object(deploy, 'PACKAGES', self.root), patch.object(deploy, 'docker') as docker:
            with patch.object(deploy, 'emit'), self.assertRaises(deploy.DeploymentError):
                deploy.local_image(checksum, REFERENCE, REVISION, image_id)
        docker.assert_not_called()

    def test_existing_release_tag_cannot_be_overwritten(self):
        image_id = make_archive(self.archive)
        checksum = digest_file(self.archive)
        self.archive.rename(self.root / (checksum + '.tar.gz'))
        with patch.object(deploy, 'PACKAGES', self.root), patch.object(deploy, 'emit'):
            with patch.object(deploy, 'docker', return_value='existing-image') as docker:
                with patch.object(deploy, 'inspect', return_value={'Id': 'different-image'}):
                    with self.assertRaisesRegex(deploy.DeploymentError, 'different image'):
                        deploy.local_image(checksum, REFERENCE, REVISION, image_id)
                self.assertFalse(any(call.args[0] == 'load' for call in docker.call_args_list))

    def test_failed_switch_restores_previous_config_and_state(self):
        config = self.root / 'compose.env'
        config.write_bytes(b'MANJI_APP_IMAGE=old:image\n')
        old = {'image': 'old:image', 'image_id': 'old-id', 'revision': REVISION}
        state = {'version': 1, 'current': old, 'previous': None}
        before = {'contents': config.read_bytes(), 'metadata': config.stat(),
                  'app': {'Id': 'old-container'}, 'record': old}
        target = {'image': REFERENCE, 'image_id': 'new-id', 'revision': REVISION}
        def inspected(reference, **_):
            return {'Id': 'old-container' if reference == deploy.APP else 'old-id'}
        with patch.object(deploy, 'CFG', self.root), patch.object(deploy, 'emit'):
            with patch.object(deploy, 'check_configuration'), patch.object(deploy, 'inspect', side_effect=inspected):
                with patch.object(deploy, 'compose') as compose:
                    with patch.object(deploy, 'verify_running', side_effect=[deploy.DeploymentError('not healthy'), None]):
                        with self.assertRaisesRegex(deploy.DeploymentError, 'previous application was restored'):
                            deploy.switch(target, before, state)
                    self.assertEqual(compose.call_count, 2)
                    for call in compose.call_args_list:
                        self.assertEqual(call.args, ('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'))
        self.assertEqual(config.read_bytes(), before['contents'])
        self.assertEqual(json.loads((self.root / 'cd-state.json').read_text()), state)

    def test_corrupt_release_package_is_rejected_before_upload(self):
        image_id = make_archive(self.archive)
        manifest = {'version': 1, 'revision': REVISION, 'image': REFERENCE, 'image_id': image_id,
                    'archive': 'image.tar.gz', 'sha256': digest_file(self.archive), 'size': self.archive.stat().st_size}
        filename = self.root / 'release.json'
        filename.write_text(json.dumps(manifest))
        self.archive.write_bytes(b'truncated')
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            release.read_manifest(filename)


if __name__ == '__main__':
    unittest.main()
