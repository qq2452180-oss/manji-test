"""Database-changing releases keep recoverable state and never roll back old code."""

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy


class DatabaseDeploymentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.patch('CFG', self.root)
        self.emit = self.patch('emit')
        self.source = {'image': 'old:image', 'image_id': 'sha256:' + '1' * 64,
                       'revision': 'a' * 40}
        self.target = {'image': 'new:image', 'image_id': 'sha256:' + '2' * 64,
                       'revision': 'b' * 40}
        self.backup = self.root / 'database-backups' / 'before-upgrade.dump'
        self.marker = self.root / 'database-upgrade.json'
        self.config_path = self.root / 'compose.env'
        self.config_path.write_text('MANJI_APP_IMAGE=' + self.source['image'] + '\n')
        self.media = {'Type': 'volume', 'Name': 'manji_media', 'Source': '/volumes/media',
                      'Destination': deploy.MEDIA, 'RW': True}
        self.app = {
            'Id': 'old-container', 'Image': self.source['image_id'],
            'Config': {'Image': self.source['image'], 'Env': ['DATABASE_URL=test-database']},
            'State': {'Running': True, 'Health': {'Status': 'healthy'}},
            'Mounts': [deepcopy(self.media)],
            'NetworkSettings': {'Networks': {'manji_default': {}}, 'Ports': {}},
        }
        self.config = {'services': {'app': {
            'image': self.source['image'], 'environment': {'DATABASE_URL': 'test-database'},
            'volumes': [{'type': 'volume', 'source': 'media', 'target': deploy.MEDIA}],
        }}}
        self.postgres = {'Id': 'postgres-container'}
        self.before = {
            'contents': self.config_path.read_bytes(), 'metadata': self.config_path.stat(),
            'config': self.config, 'app': self.app, 'record': self.source,
            'environment': self.config['services']['app']['environment'],
            'infrastructure': {deploy.PG: self.postgres['Id'], deploy.GW: 'gateway-container'},
        }
        self.plan = {'pending_versions': ['0014', '0015', '0016']}

    def patch(self, name, *args, **kwargs):
        patcher = patch.object(deploy, name, *args, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def save_upgrade(self):
        upgrade = {'version': 1, 'source': self.source, 'target': self.target,
                   'backup': str(self.backup), 'configured_image': self.source['image']}
        self.marker.write_text(json.dumps(upgrade))
        return upgrade

    def image_info(self, record):
        return {'Id': record['image_id'], 'Architecture': 'amd64', 'Os': 'linux',
                'Config': {'User': '10001:10001', 'Labels': {
            'org.opencontainers.image.revision': record['revision'],
        }}}

    def candidate(self, record=None):
        record = self.target if record is None else record
        candidate = deepcopy(self.app)
        candidate['Image'] = record['image_id']
        candidate['Mounts'][0]['RW'] = False
        candidate['Config']['Image'] = record['image']
        candidate['Config']['Labels'] = {
            'com.docker.compose.project': deploy.PROJECT,
            'com.docker.compose.service': 'app', 'com.docker.compose.oneoff': 'True',
        }
        return candidate

    def inspect_fixture(self, name, **kwargs):
        if name == deploy.APP:
            return self.app
        if name == deploy.PG:
            return self.postgres
        if name == deploy.GW:
            return {'Id': 'gateway-container'}
        for record in (self.source, self.target):
            if name == record['image_id']:
                self.assertTrue(kwargs.get('image'))
                return self.image_info(record)
        self.fail('Unexpected inspection: ' + name)

    def test_current_database_does_not_back_up_or_run_migrations(self):
        docker = self.patch('docker', return_value=json.dumps({'pending_versions': []}))
        backup = self.patch('backup_database')
        inspect = self.patch('inspect')

        self.assertFalse(deploy.migrate_database('candidate', self.target, self.before))

        docker.assert_called_once_with('exec', 'candidate', 'python', '-m', 'src.common.migrate', 'plan')
        backup.assert_not_called()
        inspect.assert_not_called()
        self.assertFalse(self.marker.exists())

    def test_backup_failure_prevents_migration_and_recovery_marker(self):
        docker = self.patch('docker', return_value=json.dumps(self.plan))
        self.patch('inspect', return_value=self.postgres)
        self.patch('backup_database', side_effect=deploy.BackupError('Backup verification failed'))

        with self.assertRaisesRegex(deploy.DeploymentError, 'Backup verification failed'):
            deploy.migrate_database('candidate', self.target, self.before)

        self.assertEqual(docker.call_count, 1)
        self.assertFalse(self.marker.exists())

    def test_backup_and_durable_recovery_marker_precede_migration(self):
        events = []
        self.patch('inspect', return_value=self.postgres)

        def backup(plan, postgres, destination):
            self.assertEqual((plan, postgres, destination),
                             (self.plan, self.postgres, self.root / 'database-backups'))
            self.assertFalse(self.marker.exists())
            events.append('backup')
            return self.backup

        def docker(*arguments, **kwargs):
            if arguments[-1] == 'plan':
                return json.dumps(self.plan)
            self.assertEqual(arguments, ('exec', 'candidate', 'python', '-c', deploy.MIGRATE_COMMAND))
            self.assertEqual(kwargs, {'timeout': deploy.MIGRATION_TIMEOUT})
            self.assertEqual(json.loads(self.marker.read_text()), {
                'version': 1, 'source': self.source, 'target': self.target, 'backup': str(self.backup),
                'configured_image': self.source['image'],
            })
            events.append('migrate')
            return '{}'

        original_write = deploy.atomic_write

        def write(*args, **kwargs):
            original_write(*args, **kwargs)
            events.append('record')

        self.patch('backup_database', side_effect=backup)
        self.patch('atomic_write', side_effect=write)
        self.patch('docker', side_effect=docker)

        self.assertTrue(deploy.migrate_database('candidate', self.target, self.before))
        self.assertEqual(events, ['backup', 'record', 'migrate'])
        self.assertTrue(self.marker.exists())

    def test_migration_failure_retains_backup_reference_and_recovery_marker(self):
        self.patch('docker', side_effect=[json.dumps(self.plan), deploy.DeploymentError('migration timed out')])
        self.patch('inspect', return_value=self.postgres)
        self.patch('backup_database', return_value=self.backup)

        with self.assertRaisesRegex(deploy.DeploymentError, 'migration timed out'):
            deploy.migrate_database('candidate', self.target, self.before)

        self.assertEqual(deploy.load_database_upgrade()['backup'], str(self.backup))
        self.assertEqual(deploy.load_database_upgrade()['target'], self.target)

    def test_recovery_record_failure_prevents_sql_write(self):
        docker = self.patch('docker', return_value=json.dumps(self.plan))
        self.patch('inspect', return_value=self.postgres)
        self.patch('backup_database', return_value=self.backup)
        self.patch('atomic_write', side_effect=OSError('disk full'))

        with self.assertRaises(OSError):
            deploy.migrate_database('candidate', self.target, self.before)

        self.assertEqual(docker.call_count, 1)

    def test_completed_migration_retry_keeps_rollback_barrier_without_another_backup(self):
        original = self.save_upgrade()
        docker = self.patch('docker', return_value=json.dumps({'pending_versions': []}))
        backup = self.patch('backup_database')

        self.assertTrue(deploy.migrate_database('candidate', self.target, self.before))

        backup.assert_not_called()
        self.assertEqual(docker.call_count, 1)
        self.assertEqual(deploy.load_database_upgrade(), original)

    def test_changed_postgres_container_is_rejected_before_backup(self):
        docker = self.patch('docker', return_value=json.dumps(self.plan))
        self.patch('inspect', return_value={'Id': 'replacement-postgres'})
        backup = self.patch('backup_database')

        with self.assertRaisesRegex(deploy.DeploymentError, 'Database container changed'):
            deploy.migrate_database('candidate', self.target, self.before)

        backup.assert_not_called()
        self.assertEqual(docker.call_count, 1)
        self.assertFalse(self.marker.exists())

    def test_failed_candidate_health_keeps_upgrade_record_and_removes_candidate(self):
        name = deploy.PROJECT + '-cd-check'
        candidate = self.candidate()
        self.patch('optional_container', side_effect=[None, candidate])
        self.patch('inspect', side_effect=lambda ref: candidate if ref == name else self.postgres)
        self.patch('check_configuration')
        compose = self.patch('compose')
        self.patch('backup_database', return_value=self.backup)
        self.patch('wait_healthy', side_effect=deploy.DeploymentError('Candidate health failed'))
        docker = self.patch('docker', side_effect=lambda *args, **kwargs:
                            json.dumps(self.plan) if args[-1] == 'plan' else '')

        with self.assertRaisesRegex(deploy.DeploymentError, 'Candidate health failed'):
            deploy.preflight(self.target, self.before, migrate=True)

        self.assertEqual(deploy.load_database_upgrade()['backup'], str(self.backup))
        docker.assert_any_call('exec', name, 'python', '-m', 'src.common.migrate', 'check')
        self.assertEqual(docker.call_args.args, ('rm', '-f', name))
        self.assertEqual(list(self.root.glob('.manji-cd-candidate-*')), [])
        self.assertEqual(compose.call_args.kwargs, {'image': self.target['image']})

    def test_migration_timeout_removes_candidate_before_any_health_check(self):
        name = deploy.PROJECT + '-cd-check'
        candidate = self.candidate()
        self.patch('optional_container', side_effect=[None, candidate])
        self.patch('inspect', side_effect=lambda ref: candidate if ref == name else self.postgres)
        self.patch('check_configuration')
        self.patch('compose')
        self.patch('backup_database', return_value=self.backup)
        wait_healthy = self.patch('wait_healthy')

        def execute(*arguments, **kwargs):
            if arguments[-1] == 'plan':
                return json.dumps(self.plan)
            if arguments[-1] == deploy.MIGRATE_COMMAND:
                raise deploy.DeploymentError('Docker operation timed out')
            self.assertEqual(arguments, ('rm', '-f', name))
            return ''

        docker = self.patch('docker', side_effect=execute)
        with self.assertRaisesRegex(deploy.DeploymentError, 'timed out'):
            deploy.preflight(self.target, self.before, migrate=True)

        self.assertEqual(docker.call_args.args, ('rm', '-f', name))
        wait_healthy.assert_not_called()
        self.assertEqual(deploy.load_database_upgrade()['target'], self.target)
        self.assertEqual(list(self.root.glob('.manji-cd-candidate-*')), [])

    def test_recovery_removes_recorded_candidate_before_starting_corrected_release(self):
        self.save_upgrade()
        name = deploy.PROJECT + '-cd-check'
        corrected = {'image': 'corrected:image', 'image_id': 'sha256:' + '3' * 64,
                     'revision': 'c' * 40}
        old_candidate, new_candidate = self.candidate(), self.candidate(corrected)
        self.patch('optional_container', side_effect=[old_candidate, old_candidate, new_candidate])
        self.patch('inspect', return_value=new_candidate)
        self.patch('check_configuration')
        self.patch('wait_healthy')
        backup = self.patch('backup_database')
        docker = self.patch('docker', side_effect=lambda *args, **kwargs:
                            json.dumps({'pending_versions': []}) if args[-1] == 'plan' else '')

        def compose(*args, **kwargs):
            docker.assert_called_once_with('rm', '-f', name)
            self.assertEqual(deploy.load_database_upgrade()['target'], self.target)

        self.patch('compose', side_effect=compose)

        self.assertTrue(deploy.preflight(corrected, self.before, migrate=True))

        backup.assert_not_called()
        self.assertEqual([call.args for call in docker.call_args_list], [
            ('rm', '-f', name),
            ('exec', name, 'python', '-m', 'src.common.migrate', 'plan'),
            ('exec', name, 'python', '-m', 'src.common.migrate', 'check'),
            ('rm', '-f', name),
        ])
        self.assertEqual(deploy.load_database_upgrade()['target'], corrected)
        self.assertEqual(deploy.load_database_upgrade()['backup'], str(self.backup))

    def test_recovery_refuses_candidate_with_wrong_image_or_compose_ownership(self):
        original = self.save_upgrade()
        docker = self.patch('docker')
        compose = self.patch('compose')
        container = self.patch('optional_container')
        variants = [('image', self.source['image_id']),
                    ('com.docker.compose.project', 'unrelated-project'),
                    ('com.docker.compose.service', 'postgres'),
                    ('com.docker.compose.oneoff', 'False'),
                    ('labels', None)]
        for field, value in variants:
            with self.subTest(field=field):
                candidate = self.candidate()
                if field == 'image':
                    candidate['Image'] = value
                elif field == 'labels':
                    candidate['Config']['Labels'] = value
                else:
                    candidate['Config']['Labels'][field] = value
                container.return_value = candidate

                with self.assertRaisesRegex(deploy.DeploymentError, 'ownership changed'):
                    deploy.preflight(self.target, self.before, migrate=True)

        docker.assert_not_called()
        compose.assert_not_called()
        self.assertEqual(deploy.load_database_upgrade(), original)

    def test_existing_candidate_without_recovery_record_is_not_removed(self):
        self.patch('optional_container', return_value=self.candidate())
        docker = self.patch('docker')
        compose = self.patch('compose')

        with self.assertRaisesRegex(deploy.DeploymentError, 'previous candidate container exists'):
            deploy.preflight(self.target, self.before, migrate=True)

        docker.assert_not_called()
        compose.assert_not_called()

    def test_retry_after_switch_can_deploy_same_image_while_unhealthy(self):
        upgrade = self.save_upgrade()
        before = {**self.before, 'record': self.target}
        recover = self.patch('recover_upgrade_application')
        snapshot = self.patch('snapshot', return_value=before)
        self.patch('load_state', return_value={'version': 1, 'current': self.source, 'previous': None})
        check_record = self.patch('check_record')
        self.patch('pull_image', return_value=self.image_info(self.target))
        preflight = self.patch('preflight', return_value=True)
        switch = self.patch('switch')

        deploy.deploy(self.target['image'], self.target['revision'])

        recover.assert_called_once_with(upgrade)
        snapshot.assert_called_once_with(require_healthy=False, upgrade=upgrade)
        check_record.assert_not_called()
        preflight.assert_called_once_with(self.target, before, migrate=True)
        self.assertEqual(switch.call_args.kwargs, {'database_changed': True})

    def test_missing_app_recovery_recreates_recorded_forward_target_without_starting_source(self):
        upgrade = self.save_upgrade()
        self.patch('optional_container', return_value=None)
        self.patch('configuration', return_value=self.config)
        inspect = self.patch('inspect', return_value=self.image_info(self.target))
        check = self.patch('check_configuration')

        def start(*args, **kwargs):
            self.assertEqual(self.config_path.read_text(), 'MANJI_APP_IMAGE=' + self.target['image'] + '\n')
            self.assertEqual(deploy.load_database_upgrade(), upgrade)

        compose = self.patch('compose', side_effect=start)

        deploy.recover_upgrade_application(upgrade)

        inspect.assert_called_once_with(self.target['image'], image=True)
        check.assert_called_once_with({'config': self.config}, self.target['image'])
        compose.assert_called_once_with('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app')
        self.emit.assert_called_once_with('database_upgrade_recreate_app', image=self.target['image'])
        self.assertEqual(deploy.load_database_upgrade(), upgrade)

    def test_missing_app_recovery_rejects_changed_target_image_without_rewriting_config(self):
        upgrade = self.save_upgrade()
        self.patch('optional_container', return_value=None)
        self.patch('configuration', return_value=self.config)
        changed = self.image_info(self.target)
        changed['Id'] = 'sha256:' + '3' * 64
        self.patch('inspect', return_value=changed)
        compose = self.patch('compose')

        with self.assertRaisesRegex(deploy.DeploymentError, 'image is missing or changed'):
            deploy.recover_upgrade_application(upgrade)

        compose.assert_not_called()
        self.assertEqual(self.config_path.read_bytes(), self.before['contents'])
        self.assertEqual(deploy.load_database_upgrade(), upgrade)

    def test_missing_app_recovery_rejects_unrecorded_configuration(self):
        upgrade = self.save_upgrade()
        self.patch('optional_container', return_value=None)
        self.config['services']['app']['image'] = 'unrelated:image'
        self.patch('configuration', return_value=self.config)
        inspect = self.patch('inspect')
        compose = self.patch('compose')

        with self.assertRaisesRegex(deploy.DeploymentError, 'Configured image differs'):
            deploy.recover_upgrade_application(upgrade)

        inspect.assert_not_called()
        compose.assert_not_called()
        self.assertEqual(self.config_path.read_bytes(), self.before['contents'])

    def test_existing_app_is_left_for_normal_recovery_snapshot(self):
        upgrade = self.save_upgrade()
        self.patch('optional_container', return_value=self.app)
        configuration = self.patch('configuration')
        compose = self.patch('compose')

        deploy.recover_upgrade_application(upgrade)

        configuration.assert_not_called()
        compose.assert_not_called()

    def test_status_remains_readable_with_missing_app_and_pending_upgrade(self):
        upgrade = self.save_upgrade()
        state = {'version': 1, 'current': self.source, 'previous': None}
        self.patch('load_state', return_value=state)
        self.patch('optional_container', return_value=None)
        self.patch('configuration', return_value=self.config)

        deploy.status()

        self.emit.assert_called_once_with(
            'status', running=None, healthy=False, database_migrations=True,
            database_upgrade_pending=upgrade, configured_image=self.source['image'],
            recorded=state, drift=True,
        )

    def test_failed_database_switch_never_restores_old_application(self):
        upgrade = self.save_upgrade()
        state = {'version': 1, 'current': self.source, 'previous': None}
        state_path = self.root / 'cd-state.json'
        state_path.write_text(json.dumps(state))
        self.patch('check_configuration')
        self.patch('inspect', return_value=self.app)
        compose = self.patch('compose')
        verify = self.patch('verify_running', side_effect=deploy.DeploymentError('not healthy'))

        with self.assertRaisesRegex(deploy.DeploymentError, 'automatic rollback is disabled'):
            deploy.switch(self.target, self.before, state, database_changed=True)

        compose.assert_called_once_with('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app')
        verify.assert_called_once_with(self.target, self.before)
        self.assertIn(self.target['image'], self.config_path.read_text())
        self.assertEqual(json.loads(state_path.read_text()), state)
        self.assertEqual(deploy.load_database_upgrade(), upgrade)

    def test_successful_database_switch_clears_marker_and_resets_rollback_history(self):
        self.save_upgrade()
        self.patch('check_configuration')
        self.patch('inspect', return_value=self.app)
        self.patch('compose')
        self.patch('verify_running')

        deploy.switch(self.target, self.before, None, database_changed=True)

        self.assertEqual(deploy.load_state(), {'version': 1, 'current': self.target, 'previous': None})
        self.assertFalse(self.marker.exists())
        self.assertIn(self.target['image'], self.config_path.read_text())

    def test_rollback_is_blocked_before_any_action_when_database_upgrade_is_pending(self):
        self.save_upgrade()
        snapshot = self.patch('snapshot')
        compose = self.patch('compose')

        with self.assertRaisesRegex(deploy.DeploymentError, 'interrupted database upgrade'):
            deploy.rollback()

        snapshot.assert_not_called()
        compose.assert_not_called()

    def test_recovery_snapshot_accepts_only_recorded_images_including_partial_switch(self):
        upgrade = self.save_upgrade()
        self.app['State']['Health']['Status'] = 'unhealthy'
        self.patch('configuration', return_value=self.config)
        self.patch('inspect', side_effect=self.inspect_fixture)

        for configured in (self.source, self.target):
            for running in (self.source, self.target):
                with self.subTest(configured=configured['image'], running=running['image']):
                    self.config['services']['app']['image'] = configured['image']
                    self.config_path.write_text('MANJI_APP_IMAGE=' + configured['image'] + '\n')
                    self.app['Config']['Image'] = running['image']
                    self.app['Image'] = running['image_id']

                    before = deploy.snapshot(require_healthy=False, upgrade=upgrade)

                    self.assertEqual(before['record'], running)
                    self.assertEqual(before['config']['services']['app']['image'], configured['image'])

    def test_recovery_snapshot_rejects_unrecorded_config_running_image_or_image_id(self):
        upgrade = self.save_upgrade()
        self.patch('configuration', return_value=self.config)
        self.patch('inspect', side_effect=self.inspect_fixture)
        for configured, running, image_id in (
            ('unrelated:image', self.source['image'], self.source['image_id']),
            (self.target['image'], 'unrelated:image', self.source['image_id']),
            (self.target['image'], self.source['image'], 'sha256:' + '3' * 64),
        ):
            with self.subTest(configured=configured, running=running, image_id=image_id):
                self.config['services']['app']['image'] = configured
                self.app['Config']['Image'] = running
                self.app['Image'] = image_id

                with self.assertRaisesRegex(deploy.DeploymentError, 'differs from the interrupted'):
                    deploy.snapshot(require_healthy=False, upgrade=upgrade)

    def test_corrected_release_recovery_remembers_preceding_config_without_trusting_its_container(self):
        upgrade = self.save_upgrade()
        upgrade['configured_image'] = 'prior-failed-target:image'
        self.config['services']['app']['image'] = upgrade['configured_image']
        self.config_path.write_text('MANJI_APP_IMAGE=' + upgrade['configured_image'] + '\n')
        self.app['State']['Health']['Status'] = 'unhealthy'
        self.patch('configuration', return_value=self.config)
        self.patch('inspect', side_effect=self.inspect_fixture)

        before = deploy.snapshot(require_healthy=False, upgrade=upgrade)
        self.assertEqual(before['record'], self.source)
        self.assertEqual(before['config']['services']['app']['image'], upgrade['configured_image'])

        self.app['Config']['Image'] = upgrade['configured_image']
        with self.assertRaisesRegex(deploy.DeploymentError, 'differs from the interrupted'):
            deploy.snapshot(require_healthy=False, upgrade=upgrade)

    def test_without_recovery_record_snapshot_rejects_unhealthy_or_drifted_app(self):
        self.patch('configuration', return_value=self.config)
        self.patch('inspect', side_effect=self.inspect_fixture)
        self.app['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaisesRegex(deploy.DeploymentError, 'not healthy'):
            deploy.snapshot()
        self.config['services']['app']['image'] = self.target['image']
        with self.assertRaisesRegex(deploy.DeploymentError, 'resolve deployment drift'):
            deploy.snapshot(require_healthy=False)


if __name__ == '__main__':
    unittest.main()
