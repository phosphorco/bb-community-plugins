"""Focused offline release safety checks. No npm, network or shared outputs."""
import contextlib
import fnmatch
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('attachment_stage', Path(__file__).with_name('thread-attachments-stage.py'))
stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage)
IDENTITY = '1de6f3db-2ed9-4d72-b3dd-8f0e2b474a2f'
WORKFLOW_SHA = 'a' * 40


def tarball(contents, extra=None):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in contents.items():
            item = tarfile.TarInfo('package/' + name); item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
        if extra:
            archive.addfile(extra)
    return buffer.getvalue()


@contextlib.contextmanager
def fixture():
    # These tiny payloads exercise full algorithms without rebuilding package
    # output. Production approved hashes are separately checked below.
    contents = {name: ('fixture:' + name).encode() for name in stage.ENTRIES}
    data = tarball(contents)
    entries = {name: (len(value), stage.digest(value)) for name, value in contents.items()}
    with tempfile.TemporaryDirectory(prefix='attachment-stage-offline-') as directory:
        output = Path(directory)
        (output / stage.TARBALL).write_bytes(data)
        with patch.object(stage, 'ENTRIES', entries), patch.object(stage, 'PRIOR_SHA1', stage.digest(data, 'sha1')):
            payload = stage.inspect_archive(data)
            yield output, data, contents, payload


def item(payload, **changes):
    return {'id': IDENTITY, 'packageName': stage.PACKAGE, 'version': stage.VERSION,
            'tag': 'latest', 'shasum': payload['sha1'], **changes}


def receipt(payload, **changes):
    return {'schema': 1, 'mode': 'candidate', 'source': stage.SOURCE, 'tagObject': stage.TAG_OBJECT,
            'package': stage.PACKAGE, 'version': stage.VERSION, 'distTag': 'latest', 'npm': stage.NPM,
            'workflowCommit': WORKFLOW_SHA, 'workflowRef': 'refs/tags/' + stage.TOOLING_TAG,
            'candidateRun': '123', 'payload': payload, **changes}


class OfflineStage(unittest.TestCase):
    def setUp(self):
        # Fail loudly if a test accidentally escapes an explicit fake.
        self.no_network = patch.object(stage.urllib.request, 'urlopen', side_effect=AssertionError('offline only'))
        self.no_process = patch.object(stage.subprocess, 'run', side_effect=AssertionError('offline only'))
        self.no_opener = patch.object(stage.urllib.request.OpenerDirector, 'open', side_effect=AssertionError('offline only'))
        self.no_network.start(); self.no_process.start(); self.no_opener.start()
        self.addCleanup(self.no_network.stop); self.addCleanup(self.no_process.stop); self.addCleanup(self.no_opener.stop)

    def test_approved_source_blob_hashes_and_public_entry_manifest(self):
        self.assertEqual(len(stage.ENTRIES), 10)
        for name in ['README.md', 'CONTRACT.md', 'LICENSE', 'package.json']:
            data = (ROOT / stage.PACKAGE_PATH / name).read_bytes()
            self.assertEqual((len(data), stage.digest(data)), stage.ENTRIES[name])
        self.assertEqual(len([n for n in stage.ENTRIES if n.startswith('dist/')]), 6)
        self.assertEqual(stage.PRIOR_SHA1, 'bbc44044952a1ab779535c1ad9c5b546562c0160')

    def test_archive_requires_exact_entries_and_hashes_without_extraction(self):
        with fixture() as (_, data, contents, payload):
            self.assertEqual(stage.inspect_archive(data), payload)
            for changed in [{**contents, 'README.md': b'changed'},
                            {k: v for k, v in contents.items() if k != 'LICENSE'},
                            {**contents, '../escape': b'x'}, {**contents, 'src/private.ts': b'x'}]:
                with self.assertRaises(ValueError):
                    stage.inspect_archive(tarball(changed))
            for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE]:
                entry = tarfile.TarInfo('package/README.md'); entry.type = kind
                with self.assertRaises(ValueError):
                    stage.inspect_archive(tarball(contents, entry))
            with self.assertRaises(ValueError):
                stage.inspect_archive(b'x' * (stage.MAX_ARCHIVE + 1))

    def test_full_candidate_digests_and_both_revisions_are_required(self):
        with fixture() as (_, data, _, payload):
            valid = receipt(payload)
            self.assertEqual(stage.validate_candidate(valid, data, WORKFLOW_SHA, '123', payload['sha256'], payload['sha512']), payload)
            for changes in [{'source': WORKFLOW_SHA}, {'workflowCommit': stage.SOURCE},
                            {'tagObject': 'b' * 40}, {'candidateRun': '999'}, {'mode': 'stage'},
                            {'npm': 'latest'}, {'payload': {**payload, 'bytes': 1}}]:
                with self.assertRaises(ValueError):
                    stage.validate_candidate({**valid, **changes}, data, WORKFLOW_SHA, '123', payload['sha256'], payload['sha512'])
            for sha256, sha512 in [('0' * 64, payload['sha512']), (payload['sha256'], '0' * 128), ('short', payload['sha512'])]:
                with self.assertRaises(ValueError):
                    stage.validate_candidate(valid, data, WORKFLOW_SHA, '123', sha256, sha512)

    def test_candidate_download_checks_run_artifact_zip_and_receipt(self):
        with fixture() as (output, data, _, payload):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as archive:
                archive.writestr(stage.TARBALL, data)
                archive.writestr('candidate.json', json.dumps(receipt(payload)))
            archive = buffer.getvalue()
            run = {'head_sha': WORKFLOW_SHA, 'status': 'completed', 'conclusion': 'success',
                   'event': 'workflow_dispatch', 'path': stage.WORKFLOW, 'head_branch': stage.TOOLING_TAG}
            artifact = {'id': 789, 'name': 'attachment-stage-candidate', 'expired': False,
                        'digest': 'sha256:' + stage.digest(archive)}
            def responses(run_change=None, artifact_change=None):
                return [{**run, **(run_change or {})}, {'total_count': 1, 'artifacts': [{**artifact, **(artifact_change or {})}]}, archive]
            for run_change, artifact_change in [({'head_sha': stage.SOURCE}, {}), ({'conclusion': 'failure'}, {}),
                                                ({}, {'digest': 'sha256:' + '0' * 64}), ({}, {'expired': True})]:
                with patch.object(stage, 'github', side_effect=responses(run_change, artifact_change)):
                    with self.assertRaises(ValueError):
                        stage.download_candidate(output, WORKFLOW_SHA, '123', payload['sha256'], payload['sha512'])
            with patch.object(stage, 'github', side_effect=responses()):
                stage.download_candidate(output, WORKFLOW_SHA, '123', payload['sha256'], payload['sha512'])
            self.assertEqual((output / stage.TARBALL).read_bytes(), data)

    def test_registry_only_explicit_404_means_absent(self):
        for status in [401, 403, 429, 500]:
            error = urllib.error.HTTPError('https://registry.npmjs.org', status, 'failure', {}, None)
            with patch.object(stage.urllib.request, 'urlopen', side_effect=error):
                with self.assertRaises(urllib.error.HTTPError):
                    stage.registry_get()
            error.close()
        error = urllib.error.HTTPError('https://registry.npmjs.org', 404, 'absent', {}, None)
        with patch.object(stage.urllib.request, 'urlopen', side_effect=error):
            self.assertEqual(stage.registry_get()['status'], 404)
        error.close()
        with patch.object(stage.urllib.request, 'urlopen') as read:
            read.return_value.__enter__.return_value.read.return_value = b'not-json'
            with self.assertRaises(ValueError):
                stage.registry_get()

    def test_stage_list_errors_or_malformed_data_are_never_empty(self):
        with fixture() as (output, _, _, payload):
            for raw in ['{}', '{"error":{"code":"E403"}}', '[{}]', json.dumps([item(payload, packageName='other')])]:
                with patch.object(stage, 'command', return_value=subprocess.CompletedProcess([], 0, raw, '')):
                    with self.assertRaises((ValueError, TypeError)):
                        stage.stage_list(output, 'list')
            with patch.object(stage, 'command', return_value=subprocess.CompletedProcess([], 1, '', 'E401')):
                with self.assertRaisesRegex(ValueError, 'not absence'):
                    stage.stage_list(output, 'list')
            with patch.object(stage, 'command', return_value=subprocess.CompletedProcess([], 0, '[]', '')):
                self.assertEqual(stage.stage_list(output, 'list'), [])

    def test_preflight_refuses_pending_stage_or_placeholder(self):
        with fixture() as (output, _, _, payload):
            (output / 'package-lock.json').write_text('fixture lock')
            candidate = receipt(payload, lockSHA256=stage.digest(b'fixture lock'))
            with patch.object(stage, 'source_fence'), patch.object(stage, 'previous_attempt_fence'):
                with patch.object(stage, 'registry_get', return_value={'status': 404}), patch.object(stage, 'stage_list', return_value=[item(payload)]):
                    with self.assertRaisesRegex(ValueError, 'unresolved stage'):
                        stage.preflight(output, output, candidate, '456')
                with patch.object(stage, 'registry_get', side_effect=[{'status': 200}, {'status': 404}]), patch.object(stage, 'stage_list') as listing:
                    with self.assertRaisesRegex(ValueError, 'absent package'):
                        stage.preflight(output, output, candidate, '456')
                    listing.assert_not_called()

    def test_history_rejects_direct_retry_prior_stage_or_unresolved_run(self):
        prior = {'id': stage.PRIOR_RUN, 'head_sha': stage.SOURCE, 'status': 'completed', 'conclusion': 'failure', 'run_attempt': 1}
        normal = {'total_count': 1, 'workflow_runs': [prior]}
        history = {'total_count': 1, 'workflow_runs': [{'id': 123, 'status': 'completed'}]}
        skipped = {'total_count': 1, 'jobs': [{'name': 'Stage retained candidate', 'conclusion': 'skipped'}]}
        with patch.object(stage, 'github', side_effect=[prior, normal, history, skipped]):
            stage.previous_attempt_fence('456')
        for values in [[{**prior, 'run_attempt': 2}], [prior, {'workflow_runs': [{'status': 'in_progress'}]}],
                       [prior, {'total_count': 101, 'workflow_runs': []}],
                       [prior, normal, history, {'total_count': 1, 'jobs': [{'name': 'Stage retained candidate', 'conclusion': 'failure'}]}]]:
            with patch.object(stage, 'github', side_effect=values):
                with self.assertRaises(ValueError):
                    stage.previous_attempt_fence('456')

    def test_completed_failed_new_publication_blocks_even_when_registry_is_absent(self):
        prior = {'id': stage.PRIOR_RUN, 'head_sha': stage.SOURCE, 'status': 'completed', 'conclusion': 'failure', 'run_attempt': 1}
        unknown = {'id': 999, 'head_sha': stage.SOURCE, 'event': 'workflow_dispatch',
                   'status': 'completed', 'conclusion': 'failure', 'run_attempt': 1}
        def github(path, **kwargs):
            if path == 'actions/runs/' + str(stage.PRIOR_RUN):
                return prior
            if path.startswith('actions/workflows/publish.yml/runs?'):
                self.assertNotIn('status=', path)
                return {'total_count': 2, 'workflow_runs': [unknown, prior]}
            if path == 'actions/runs/999/artifacts?per_page=100':
                return {'total_count': 0, 'artifacts': []}
            raise AssertionError('Unexpected read: ' + path)
        with fixture() as (output, _, _, payload):
            (output / 'package-lock.json').write_bytes(b'fixed')
            candidate = receipt(payload, lockSHA256=stage.digest(b'fixed'))
            with patch.object(stage, 'source_fence'), patch.object(stage, 'github', side_effect=github), patch.object(stage, 'registry_get', return_value={'status': 404}), patch.object(stage, 'stage_list', return_value=[]), patch.object(stage, 'submit') as submit:
                with self.assertRaisesRegex(ValueError, 'unambiguous retained release receipt'):
                    stage.preflight(output, output, candidate, '456')
                submit.assert_not_called()
            self.assertTrue((output / 'ordinary-run-history.json').exists())

    def test_completed_run_exemptions_need_verified_selection_and_skipped_writes(self):
        def archive(receipt):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as zipped:
                zipped.writestr('release-receipt.json', json.dumps(receipt))
            return buffer.getvalue()
        run = {'id': 999, 'head_sha': WORKFLOW_SHA, 'status': 'completed', 'conclusion': 'failure'}
        for plugin, dry, write, expected in [('bb-thread-attachments', False, 'failure', False),
                                            ('bb-thread-attachments', True, 'failure', False),
                                            ('bb-thread-attachments', True, 'skipped', True),
                                            ('bb-markdown', False, 'success', True)]:
            with self.subTest(plugin=plugin, dry=dry, write=write):
                selected = {'sha': WORKFLOW_SHA, 'plugin': plugin, 'path': 'packages/' + plugin,
                            'workspace': '@phosphorco/' + plugin, 'dryRun': dry}
                data = archive(selected)
                artifact = {'id': 789, 'name': 'release-receipt-' + plugin, 'expired': False, 'digest': 'sha256:' + stage.digest(data)}
                jobs = {'total_count': 1, 'jobs': [{'status': 'completed', 'steps': [{'name': 'Publish public package', 'conclusion': write}]}]}
                with patch.object(stage, 'github', side_effect=[{'total_count': 1, 'artifacts': [artifact]}, data, jobs]):
                    if expected:
                        self.assertIn('verified-', stage.ordinary_disposition(run, None)['disposition'])
                    else:
                        with self.assertRaises(ValueError):
                            stage.ordinary_disposition(run, None)

    def test_blob_redirect_never_forwards_github_credential(self):
        handler = stage.CredentialRedirect()
        request = stage.urllib.request.Request('https://api.github.com/artifact', headers={'Authorization': 'Bearer secret'})
        redirected = handler.redirect_request(request, None, 302, 'moved', {}, 'https://blob.example/artifact.zip')
        self.assertFalse(redirected.has_header('Authorization'))
        with self.assertRaises(ValueError):
            handler.redirect_request(request, None, 302, 'moved', {}, 'http://blob.example/artifact.zip')

    def test_transport_uses_no_shell_stdin_or_retries_and_redacts_only_credentials(self):
        done = subprocess.CompletedProcess([], 0, 'actual-secret account=octocat', 'path=/tmp/x')
        with patch.dict(stage.os.environ, {'NODE_AUTH_TOKEN': 'actual-secret'}), patch.object(stage.subprocess, 'run', return_value=done) as run:
            result = stage.command(['npm', 'stage', 'list'])
            self.assertEqual(result.stdout, '[credential:NODE_AUTH_TOKEN] account=octocat')
            self.assertEqual(result.stderr, 'path=/tmp/x')
            self.assertEqual(run.call_args.kwargs['env']['NPM_CONFIG_FETCH_RETRIES'], '0')
            self.assertEqual(run.call_args.kwargs['stdin'], subprocess.DEVNULL)
            self.assertNotIn('shell', run.call_args.kwargs)

    def test_successful_single_stage_requires_exact_download_before_handoff(self):
        with fixture() as (output, data, _, payload):
            answer = {stage.PACKAGE: {'stageId': IDENTITY, 'name': stage.PACKAGE,
                                     'version': stage.VERSION, 'shasum': payload['sha1']}}
            def read(args, dest, label, cwd=None):
                if args[0] == 'view':
                    return item(payload)
                (cwd / ('phosphorco-bb-thread-attachments-0.1.0-' + IDENTITY + '.tgz')).write_bytes(data)
                return {stage.PACKAGE: {}}
            with patch.object(stage, 'command', return_value=subprocess.CompletedProcess([], 0, json.dumps(answer), '')) as call, patch.object(stage, 'registry_get', return_value={'status': 404}), patch.object(stage, 'stage_list', return_value=[item(payload)]) as listing, patch.object(stage, 'npm_read', side_effect=read):
                outcome = stage.submit(output, payload)
            self.assertTrue(outcome['approvalReady'])
            self.assertEqual(outcome['downloadedPayload'], payload)
            self.assertFalse(outcome['publishedVersionVerified'])
            self.assertEqual(call.call_count, 1); listing.assert_called_once()
            self.assertIn('--fetch-retries=0', call.call_args.args[0])
            self.assertEqual(call.call_args.args[0][:3], ['npm', 'stage', 'publish'])
            with self.assertRaises(FileExistsError):
                stage.submit(output, payload)

    def test_failed_timeout_or_malformed_ack_never_replays_and_postflights_once(self):
        errors = [subprocess.CompletedProcess([], 1, '', 'E403'),
                  subprocess.CompletedProcess([], 0, '{}', ''),
                  subprocess.CompletedProcess([], 0, json.dumps({stage.PACKAGE: {'stageId': 'bad'}}), ''),
                  subprocess.TimeoutExpired(['npm', 'stage', 'publish'], 180)]
        for error in errors:
            with self.subTest(error=error), fixture() as (output, _, _, payload):
                with patch.object(stage, 'command', **({'side_effect': error} if isinstance(error, Exception) else {'return_value': error})) as call, patch.object(stage, 'registry_get', return_value={'status': 404}) as registry, patch.object(stage, 'stage_list', return_value=[]) as listing:
                    with self.assertRaisesRegex(ValueError, 'Unknown stage outcome'):
                        stage.submit(output, payload)
                self.assertEqual(call.call_count, 1); listing.assert_called_once(); self.assertEqual(registry.call_count, 2)
                outcome = json.loads((output / 'stage-outcome.json').read_text())
                self.assertEqual(outcome['state'], 'unknown'); self.assertFalse(outcome['approvalReady'])
                self.assertTrue((output / 'stage-intent.json').exists())

    def test_timeout_retains_partial_nonsecret_diagnostics_with_credential_provenance(self):
        with fixture() as (output, _, _, payload), patch.dict(stage.os.environ, {'NODE_AUTH_TOKEN': 'test-secret'}):
            expired = subprocess.TimeoutExpired(['npm', 'stage', 'publish'], 180,
                                                output=b'actor=octocat token=test-secret', stderr=b'endpoint=/stage timed out')
            with patch.object(stage.subprocess, 'run', side_effect=expired) as raw, patch.object(stage, 'registry_get', return_value={'status': 404}), patch.object(stage, 'stage_list', return_value=[]):
                with self.assertRaisesRegex(ValueError, 'Unknown stage outcome'):
                    stage.submit(output, payload)
            self.assertEqual(raw.call_count, 1)
            self.assertEqual((output / 'stage.stdout').read_text(), 'actor=octocat token=[credential:NODE_AUTH_TOKEN]')
            self.assertEqual((output / 'stage.stderr').read_text(), 'endpoint=/stage timed out')
            self.assertFalse(json.loads((output / 'stage-outcome.json').read_text())['approvalReady'])

    def test_wrong_stage_view_or_download_cannot_be_approved(self):
        for bad_view in [True, False]:
            with self.subTest(bad_view=bad_view), fixture() as (output, data, _, payload):
                ack = {stage.PACKAGE: {'stageId': IDENTITY, 'name': stage.PACKAGE, 'version': stage.VERSION, 'shasum': payload['sha1']}}
                def read(args, dest, label, cwd=None):
                    if args[0] == 'view':
                        return item(payload, tag='wrong' if bad_view else 'latest')
                    (cwd / ('phosphorco-bb-thread-attachments-0.1.0-' + IDENTITY + '.tgz')).write_bytes(data + b'changed')
                    return {}
                with patch.object(stage, 'command', return_value=subprocess.CompletedProcess([], 0, json.dumps(ack), '')), patch.object(stage, 'registry_get', return_value={'status': 404}), patch.object(stage, 'stage_list', return_value=[item(payload)]), patch.object(stage, 'npm_read', side_effect=read):
                    with self.assertRaises(ValueError):
                        stage.submit(output, payload)
                self.assertFalse(json.loads((output / 'stage-outcome.json').read_text())['approvalReady'])

    def test_workflow_separates_revisions_candidate_and_stage(self):
        workflow = (ROOT / stage.WORKFLOW).read_text()
        self.assertEqual(workflow.count('ref: ' + stage.SOURCE), 2)
        self.assertEqual(workflow.count('ref: ${{ github.sha }}'), 2)
        self.assertIn('options: [candidate, stage]', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('npm@' + stage.NPM, workflow)
        self.assertIn('test "$GITHUB_RUN_ATTEMPT" = 1', workflow)
        self.assertEqual(workflow.count('python3 .github/scripts/test-thread-attachments-stage.py'), 2)
        stage_job = workflow.split('\n  stage:\n')[1]
        self.assertNotIn('npm ci', stage_job); self.assertNotIn('npm pack', stage_job)
        self.assertNotIn('npm publish', workflow); self.assertNotIn('npm stage approve', workflow)
        # Keep SDK archive/provenance hashes identical to the existing route.
        original = (ROOT / '.github/workflows/publish.yml').read_text()
        filters = [line.strip().removeprefix('- ').strip('"') for line in original.splitlines()
                   if line.startswith('      - "')]
        self.assertTrue(filters)
        self.assertFalse(any(fnmatch.fnmatchcase(stage.TOOLING_TAG, value) for value in filters))
        for line in workflow.splitlines():
            if '| sha256sum --check' in line:
                checksum = line.split("'")[1]
                self.assertIn(checksum, original)


if __name__ == '__main__':
    unittest.main()
