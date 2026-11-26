"""Stream a verified backup of the application's existing PostgreSQL database."""

from datetime import datetime, timezone
import ipaddress
import os
from pathlib import Path
import subprocess
import tempfile
import uuid


BACKUP_TIMEOUT = 600


class BackupError(RuntimeError):
    """An operational message safe to return to the deployment client."""


def _backup_target(plan, postgres):
    database = plan.get('database')
    if not isinstance(database, str) or not database.strip() or '\x00' in database:
        raise BackupError('Application database name could not be identified')
    identifier = postgres.get('Id')
    if (not isinstance(identifier, str) or not identifier
            or identifier.startswith('-') or '\x00' in identifier):
        raise BackupError('Existing PostgreSQL container could not be identified')
    try:
        address = ipaddress.ip_address(plan.get('server_address'))
        networks = postgres['NetworkSettings']['Networks'].values()
        addresses = {
            ipaddress.ip_address(network[key])
            for network in networks
            for key in ('IPAddress', 'GlobalIPv6Address')
            if network.get(key)
        }
    except (KeyError, TypeError, ValueError, AttributeError):
        raise BackupError('Application database server could not be verified') from None
    if plan.get('server_port') != 5432 or address not in addresses:
        raise BackupError('Application database is not on the existing PostgreSQL container')
    return database, identifier


def backup_database(plan: dict, postgres: dict, directory: Path) -> Path:
    """Publish a private custom-format dump only after pg_restore can read it.

    The database identity comes from the application's live connection. Match
    that identity to the existing container before using its local admin role;
    otherwise a valid dump of an unrelated database could give false assurance.
    """
    database, identifier = _backup_target(plan, postgres)
    directory = Path(directory)
    temporary = None
    try:
        if directory.is_symlink():
            raise BackupError('Database backup directory must not be a symbolic link')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
        descriptor, filename = tempfile.mkstemp(prefix='.database-', suffix='.partial', dir=directory)
        temporary = Path(filename)
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), 0o600)
            result = subprocess.run(
                ['docker', 'exec', '--env', 'PGDATABASE=' + database, identifier,
                 'sh', '-c', 'exec pg_dump --format=custom --no-password '
                 '--username="${POSTGRES_USER:-postgres}"'],
                stdout=output, stderr=subprocess.DEVNULL, timeout=BACKUP_TIMEOUT,
            )
            if result.returncode:
                raise BackupError('Database backup failed; application was not switched')
            output.flush()
            os.fsync(output.fileno())
        if temporary.stat().st_size == 0:
            raise BackupError('Database backup is empty; application was not switched')
        with temporary.open('rb') as source:
            result = subprocess.run(
                ['docker', 'exec', '-i', identifier, 'pg_restore', '--list'],
                stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=BACKUP_TIMEOUT,
            )
        if result.returncode:
            raise BackupError('Database backup validation failed; application was not switched')
        timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        destination = directory / ('database-' + timestamp + '-' + uuid.uuid4().hex + '.dump')
        os.replace(temporary, destination)
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return destination
    except subprocess.TimeoutExpired:
        raise BackupError('Database backup timed out; application was not switched') from None
    except OSError:
        raise BackupError('Database backup could not be saved or verified; application was not switched') from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
