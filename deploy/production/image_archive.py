"""Validate a complete Docker archive without extracting files to the filesystem."""

import gzip
import hashlib
import json
import tarfile


SOURCE = 'https://github.com/qq2452180-oss/manji-test'


def digest_file(path):
    with open(path, 'rb') as stream:
        return digest_stream(stream)


def digest_stream(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
    return digest.hexdigest()


def inspect_archive(path, reference, revision, expected_id=None):
    """Check config identity and every uncompressed layer (including cached layers)."""
    with tarfile.open(path, 'r:*') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive entries')

        def read_entry(name):
            member = archive.getmember(name)
            if not member.isfile():
                raise ValueError('Image metadata and layers must be regular files')
            return archive.extractfile(member)

        with read_entry('manifest.json') as stream:
            manifests = json.load(stream)
        if len(manifests) != 1 or manifests[0]['RepoTags'] != [reference]:
            raise ValueError('Archive must contain exactly the requested image tag')
        manifest = manifests[0]
        with read_entry(manifest['Config']) as stream:
            contents = stream.read()
        image_id = 'sha256:' + hashlib.sha256(contents).hexdigest()
        if expected_id is not None and image_id != expected_id:
            raise ValueError('Image config digest differs from the release manifest')
        config = json.loads(contents)
        labels = config['config'].get('Labels') or {}
        if (config['architecture'] != 'amd64' or config['os'] != 'linux'
                or config['config'].get('User') != '10001:10001'
                or labels.get('org.opencontainers.image.revision') != revision
                or labels.get('org.opencontainers.image.source') != SOURCE):
            raise ValueError('Image architecture, user, revision or source is incorrect')
        layers = manifest['Layers']
        differences = config['rootfs']['diff_ids']
        if not layers or len(layers) != len(differences):
            raise ValueError('Image layer list is incomplete')
        for name, expected in zip(layers, differences):
            with read_entry(name) as stream:
                compressed = stream.read(2) == b'\x1f\x8b'
                stream.seek(0)
                if compressed:
                    with gzip.GzipFile(fileobj=stream) as expanded:
                        actual = digest_stream(expanded)
                else:
                    actual = digest_stream(stream)
            if 'sha256:' + actual != expected:
                raise ValueError('Missing or damaged image layer: ' + name)
    return {'image_id': image_id, 'layers': differences}
