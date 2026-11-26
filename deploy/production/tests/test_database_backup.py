import copy
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from database_backup import BackupError, backup_database


class DatabaseBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / 'backups'
        self.plan = {'database': 'manji_v2', 'server_address': '172.19.0.3', 'server_port': 5432}
        self.postgres = {
            'Id': 'postgres-container',
            'NetworkSettings': {'Networks': {
                'manji': {'IPAddress': '172.19.0.3', 'GlobalIPv6Address': 'fd00::3'},
            }},
        }

    def test_unverified_database_never_runs_dump(self):
        for values in ({'server_address': '192.0.2.10'}, {'server_port': 5433},
                       {'database': ''}, {'database': None}, {'server_address': None},
                       {'server_address': '172.19.0.99/24'}, {'server_address': '192.0.2.10/0'},
                       {'server_address': '192.0.2.10/32'}, {'server_address': 'fd00::99/128'},
                       {'server_address': '172.19.0.3/33'}, {'server_address': 'fd00::3/129'},
                       {'server_address': ''}):
            plan = dict(self.plan, **values)
            with self.subTest(values=values), patch('database_backup.subprocess.run') as run:
                with self.assertRaises(BackupError):
                    backup_database(plan, self.postgres, self.directory)
                run.assert_not_called()
                self.assertFalse(self.directory.exists())

    def test_streams_dump_then_validates_archive_and_sets_private_permissions(self):
        contents = b'PGDMP\x00archive contents for a simulated database'
        self.directory.mkdir(mode=0o755)

        def run(arguments, **kwargs):
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            self.assertEqual(kwargs['timeout'], 600)
            if 'PGDATABASE=manji_v2' in arguments:
                self.assertEqual(arguments[:5], ['docker', 'exec', '--env',
                                                'PGDATABASE=manji_v2', 'postgres-container'])
                self.assertIn('--username="${POSTGRES_USER:-postgres}"', arguments[-1])
                self.assertTrue(hasattr(kwargs['stdout'], 'fileno'))
                self.assertEqual(stat.S_IMODE(os.fstat(kwargs['stdout'].fileno()).st_mode), 0o600)
                kwargs['stdout'].write(contents)
            else:
                self.assertEqual(arguments, ['docker', 'exec', '-i', 'postgres-container', 'pg_restore', '--list'])
                self.assertEqual(kwargs['stdout'], subprocess.DEVNULL)
                self.assertEqual(kwargs['stdin'].read(), contents)
                self.assertEqual(list(self.directory.glob('*.dump')), [])
            return subprocess.CompletedProcess(arguments, 0)

        with patch('database_backup.subprocess.run', side_effect=run) as command:
            result = backup_database(self.plan, self.postgres, self.directory)
        self.assertEqual(command.call_count, 2)
        self.assertEqual(result.read_bytes(), contents)
        self.assertEqual(result.suffix, '.dump')
        self.assertEqual(list(self.directory.iterdir()), [result])
        self.assertEqual(stat.S_IMODE(result.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)

    def test_dump_failure_and_timeout_leave_no_backup(self):
        for failure in ('exit', 'timeout', 'empty'):
            def run(arguments, **kwargs):
                if failure != 'empty':
                    kwargs['stdout'].write(b'partial dump')
                if failure == 'timeout':
                    raise subprocess.TimeoutExpired(arguments, 600, stderr=b'private password')
                return subprocess.CompletedProcess(arguments, 1 if failure == 'exit' else 0)

            with self.subTest(failure=failure), patch('database_backup.subprocess.run', side_effect=run) as command:
                with self.assertRaises(BackupError) as error:
                    backup_database(self.plan, self.postgres, self.directory)
                self.assertNotIn('private password', str(error.exception))
                self.assertEqual(command.call_count, 1)
                self.assertEqual(list(self.directory.iterdir()), [])

    def test_invalid_archive_is_not_published(self):
        def run(arguments, **kwargs):
            if 'pg_restore' in arguments:
                return subprocess.CompletedProcess(arguments, 1)
            kwargs['stdout'].write(b'broken archive')
            return subprocess.CompletedProcess(arguments, 0)

        with patch('database_backup.subprocess.run', side_effect=run):
            with self.assertRaisesRegex(BackupError, 'validation failed'):
                backup_database(self.plan, self.postgres, self.directory)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_ipv6_identity_is_normalized(self):
        plan = dict(self.plan, server_address='fd00:0:0:0:0:0:0:3')
        with patch('database_backup.subprocess.run', return_value=subprocess.CompletedProcess([], 1)) as command:
            with self.assertRaisesRegex(BackupError, 'backup failed'):
                backup_database(plan, self.postgres, self.directory)
        self.assertEqual(command.call_count, 1)

    def test_postgres_inet_host_prefixes_match_exact_container_address(self):
        for address in ('172.19.0.3/32', 'fd00::3/128', 'fd00:0:0:0:0:0:0:3/128'):
            plan = dict(self.plan, server_address=address)

            def run(arguments, **kwargs):
                if 'pg_restore' not in arguments:
                    kwargs['stdout'].write(b'PGDMP\x00test archive')
                return subprocess.CompletedProcess(arguments, 0)

            with self.subTest(address=address), patch('database_backup.subprocess.run', side_effect=run) as command:
                result = backup_database(plan, self.postgres, self.directory)
                self.assertTrue(result.is_file())
                self.assertEqual(command.call_count, 2)

    def test_missing_container_networks_is_rejected(self):
        postgres = copy.deepcopy(self.postgres)
        postgres['NetworkSettings'] = {}
        with patch('database_backup.subprocess.run') as command:
            with self.assertRaisesRegex(BackupError, 'server could not be verified'):
                backup_database(self.plan, postgres, self.directory)
        command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
