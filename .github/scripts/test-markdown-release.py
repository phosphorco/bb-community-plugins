"""Offline Markdown-only release gate tests. No registry, workflow or source publication.

Uses an actual disposable Git fixture, real archive/receipt/source validation and
fixed in-memory GitHub/registry replies. Only the final npm write is intercepted.
"""
from pathlib import Path
import base64
from contextlib import contextmanager, redirect_stdout
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TEXT = (ROOT / '.github/workflows/publish.yml').read_text()
STEPS = dict(re.findall(r'^      - name: ([^\n]+)\n(.*?)(?=^      - name: |\Z)', TEXT, re.M | re.S))
SELECT = '\n'.join(line[10:] for line in re.search(r'^        run: \|\n(.*)', STEPS['Select and verify the release source'], re.M | re.S).group(1).splitlines())
spec = importlib.util.spec_from_file_location('markdown_pinned', ROOT / '.github/scripts/bb-identity-next-release.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
SHA = 'a' * 40

def select(**changes):
    with tempfile.TemporaryDirectory(prefix='markdown-select-') as temporary:
        out = Path(temporary, 'out')
        env = {**os.environ, 'REQUESTED_PLUGIN': 'bb-markdown', 'REQUESTED_DIST_TAG': 'latest', 'FAKE_VERSION': '0.1.0', 'FAKE_SHA': SHA, 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF_NAME': 'main', 'GITHUB_SHA': SHA, 'GITHUB_OUTPUT': str(out), 'EXPECTED_SHA': SHA, 'EXPECTED_VERSION': '0.1.0', 'DRY_RUN': 'true', 'EXPECTED_PAYLOAD_SHA256': 'b' * 64, 'PROOF_RUN_ID': '', 'EXPECTED_RECEIPT_SHA256': ''}
        env.update(changes)
        stubs = ('npm() { printf \'{"w":"%s"}\' "$FAKE_VERSION"; }\n'
                 'git() { case "$*" in "rev-parse HEAD") echo "$FAKE_SHA";; *"refs/tags/"*) return 1;; *) return 0;; esac; }\n')
        result = subprocess.run(['bash', '-e', '-c', stubs + SELECT], env=env, text=True, capture_output=True)
        values = dict(line.split('=', 1) for line in out.read_text().splitlines()) if out.exists() else {}
        return result, values

def chosen(step, dry=False, pinned='true', route='markdown-bootstrap', plugin='bb-markdown'):
    expression = re.search(r'^        if: \$\{\{ (.+) \}\}', STEPS[step], re.M).group(1)
    values = {'inputs.dry_run': dry, 'inputs.plugin': plugin, 'inputs.dist_tag': 'latest', 'github.event_name': 'workflow_dispatch', 'steps.release.outputs.plugin': plugin, 'steps.release.outputs.pinned_next': pinned, 'steps.release.outputs.pinned_route': route}
    for key, value in values.items():
        expression = expression.replace(key, repr(value))
    expression = re.sub(r'!(?!=)', 'not ', expression.replace('&&', ' and ').replace('||', ' or '))
    return eval(expression, {'__builtins__': {}}, {})

@contextmanager
def fixture():
    old = Path.cwd()
    h.bind('bb-markdown', '0.1.0')
    with tempfile.TemporaryDirectory(prefix='markdown-release-fixture-') as temporary:
        root = Path(temporary)
        os.chdir(root)
        try:
            for name in [h.WORKFLOW, h.HELPER]:
                Path(name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, name)
            Path(h.PACKAGE).mkdir(parents=True)
            manifest = {'name': h.NAME, 'version': h.VERSION, 'exports': {'.': {'import': './dist/index.js'}}, 'publishConfig': {'access': 'public'}}
            Path(h.PACKAGE, 'package.json').write_text(json.dumps(manifest))
            Path(h.PACKAGE, 'source.ts').write_text('export const source = 1;\n')
            Path('package.json').write_text('{"private":true}')
            Path('package-lock.json').write_text('{}')
            def git(*args):
                return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL).decode().strip()
            git('init', '-q');git('add', '.')
            git('-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Offline release fixture only')
            sha = git('rev-parse', 'HEAD')
            h.OUT.mkdir()
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                for name, content in [('package/package.json', json.dumps(manifest).encode()), ('package/dist/index.js', b'export const test = 1;')]:
                    info = tarfile.TarInfo(name);info.size = len(content);info.mode = 0o644
                    archive.addfile(info, io.BytesIO(content))
            raw = stream.getvalue()
            (h.OUT / h.TGZ).write_bytes(raw)
            (h.OUT / 'pack.json').write_text(json.dumps([{'filename': h.TGZ, 'shasum': hashlib.sha1(raw).hexdigest(), 'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()}]))
            env = {**os.environ, 'EXPECTED_SHA': sha, 'EXPECTED_VERSION': '0.1.0', 'GITHUB_SHA': sha, 'GITHUB_REPOSITORY': h.REPOSITORY, 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'RELEASE_DIST_TAG': 'latest', 'DRY_RUN': 'true', 'EXPECTED_PAYLOAD_SHA256': h.digest(raw), 'PROOF_RUN_ID': '123', 'EXPECTED_RECEIPT_SHA256': '', 'NODE_AUTH_TOKEN': 'offline-placeholder', 'GH_TOKEN': 'offline-read-proof', 'EXPECTED_PREFLIGHT_TAGS': '{}'}
            with patch.dict(os.environ, env, clear=True), redirect_stdout(io.StringIO()):
                yield root, raw, sha
        finally:
            os.chdir(old)

def capture():
    h.capture()
    receipt = h.bounded_file(h.OUT / h.RECEIPT)
    os.environ['EXPECTED_RECEIPT_SHA256'] = h.digest(receipt)
    os.environ['DRY_RUN'] = 'false'
    return receipt

def proof(sha, receipt, raw):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as zipped:
        zipped.writestr(h.TGZ, raw);zipped.writestr(h.RECEIPT, receipt)
    artifact = {'id': 456, 'name': f'{h.ARTIFACT}-{sha}-123', 'expired': False, 'size_in_bytes': len(archive.getvalue()), 'workflow_run': {'id': 123, 'head_sha': sha}}
    run = {'id': 123, 'repository': {'full_name': h.REPOSITORY}, 'head_repository': {'full_name': h.REPOSITORY}, 'path': h.WORKFLOW, 'head_sha': sha, 'event': 'workflow_dispatch', 'status': 'completed', 'conclusion': 'success'}
    replies = {f'repos/{h.REPOSITORY}/actions/runs/123': run, f'repos/{h.REPOSITORY}/actions/runs/123/artifacts?per_page=100': {'total_count': 1, 'artifacts': [artifact]}, f'repos/{h.REPOSITORY}/actions/artifacts/456/zip': archive.getvalue(), f'repos/{h.REPOSITORY}/actions/artifacts/456': artifact}
    def api(path, binary=False):
        if path not in replies:
            raise AssertionError('Unexpected API endpoint: ' + path)
        return copy.deepcopy(replies[path])
    return api, replies

def missing():
    return 1, {'error': {'code': 'E404', 'summary': 'Not Found - GET https://registry.npmjs.org/@phosphorco%2fbb-markdown - Not found'}}

def downloaded(sha, raw):
    receipt = capture();api, replies = proof(sha, receipt, raw)
    shutil.rmtree(h.OUT)
    with patch.object(h, 'api', side_effect=api):
        h.download()
    with patch.object(h, 'registry_read', side_effect=[missing(), missing()]):
        h.preflight()
    return api, replies

class Selection(unittest.TestCase):
    def test_manual_dryrun_requires_exact_source_version_tag_and_local_payload(self):
        result, values = select()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values['pinned_next'], 'true');self.assertEqual(values['pinned_route'], 'markdown-bootstrap')
        self.assertEqual(values['pinned_tgz'], 'phosphorco-bb-markdown-0.1.0.tgz')
        for change in [{'EXPECTED_SHA': ''}, {'EXPECTED_SHA': 'c' * 40}, {'GITHUB_SHA': 'c' * 40}, {'EXPECTED_VERSION': '0.2.0'}, {'FAKE_VERSION': '0.1.1'}, {'REQUESTED_DIST_TAG': 'next'}, {'EXPECTED_PAYLOAD_SHA256': ''}, {'EXPECTED_PAYLOAD_SHA256': 'A' * 64}]:
            with self.subTest(change=change):self.assertNotEqual(select(**change)[0].returncode, 0)

    def test_actual_requires_proof_and_receipt_hash_in_addition_to_local_payload(self):
        self.assertNotEqual(select(DRY_RUN='false')[0].returncode, 0)
        result, values = select(DRY_RUN='false', PROOF_RUN_ID='123', EXPECTED_RECEIPT_SHA256='c' * 64)
        self.assertEqual(result.returncode, 0, result.stderr);self.assertEqual(values['pinned_next'], 'true')
        for changes in [{'PROOF_RUN_ID': '0'}, {'PROOF_RUN_ID': '../123'}, {'EXPECTED_RECEIPT_SHA256': ''}]:
            env = {'DRY_RUN': 'false', 'PROOF_RUN_ID': '123', 'EXPECTED_RECEIPT_SHA256': 'c' * 64, **changes}
            self.assertNotEqual(select(**env)[0].returncode, 0)

    def test_tag_and_default_generic_route_cannot_publish_markdown(self):
        self.assertNotIn('      - "bb-markdown/v*"', TEXT)
        for plugin in ['bb-markdown', '']:
            self.assertNotEqual(select(REQUESTED_PLUGIN=plugin, GITHUB_EVENT_NAME='push', GITHUB_REF_NAME='bb-markdown/v0.1.0', DRY_RUN='false')[0].returncode, 0)
        self.assertFalse(chosen('Publish public package', pinned='false'))
        publish_steps = ['Publish public package', 'Publish context recognition through trusted publisher', 'Publish only the reviewed pinned-next tgz', 'Bootstrap membership from the reviewed tgz', 'Bootstrap Markdown from the exact reviewed tgz']
        for name in publish_steps:self.assertFalse(chosen(name, dry=True), name)
        self.assertEqual([name for name in publish_steps if chosen(name)], ['Bootstrap Markdown from the exact reviewed tgz'])

    def test_actual_phase_skips_install_build_pack_and_uses_existing_credentials(self):
        for name in ['Acquire the exact fork SDK release artifact', 'Install locked dependencies', 'Build shared packages for tests', 'Test', 'Typecheck', 'Build BB artifacts', 'Inspect package contents', 'Verify Markdown packed consumer and public SDK peers', 'Pack the pinned-next dry-run payload once']:
            self.assertFalse(chosen(name), name)
        for name in ['Acquire the exact fork SDK release artifact', 'Install locked dependencies', 'Build shared packages for tests', 'Test', 'Typecheck', 'Verify Markdown packed consumer and public SDK peers', 'Pack the pinned-next dry-run payload once']:
            self.assertTrue(chosen(name, dry=True), name)
        step = STEPS['Bootstrap Markdown from the exact reviewed tgz']
        self.assertIn('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}', step)
        self.assertIn('GH_TOKEN: ${{ github.token }}', step)
        self.assertNotIn('npm publish', step);self.assertNotIn('npm pack', step);self.assertNotIn('npm run build', step)
        self.assertEqual(step.count('bb-identity-next-release.py publish >'), 1)
        for workflow in [TEXT, (ROOT / '.github/workflows/validate-pull-request.yml').read_text()]:
            self.assertIn('python3 .github/scripts/test-markdown-release.py', workflow)

class ArchiveProof(unittest.TestCase):
    def test_capture_retains_actual_archive_hash_source_version_tag_and_receipt(self):
        with fixture() as (root, raw, sha):
            capture();r = json.loads((h.OUT / h.RECEIPT).read_text())
            self.assertEqual((h.OUT / h.TGZ).read_bytes(), raw)
            self.assertEqual((r['sourceCommit'], r['version'], r['distTag'], r['dryRun']), (sha, '0.1.0', 'latest', True))
            self.assertEqual(r['payload']['sha256'], os.environ['EXPECTED_PAYLOAD_SHA256'])
            self.assertEqual(set(r['sourceFiles']), {h.WORKFLOW, h.HELPER, 'package.json', 'package-lock.json', h.PACKAGE + '/package.json', h.PACKAGE + '/source.ts'})
            h.verify()

    def test_dryrun_payload_source_or_event_mismatch_produces_no_proof_receipt(self):
        for change in ['hash', 'source', 'tag', 'version', 'event', 'dry']:
            with self.subTest(change=change), fixture():
                if change == 'hash':os.environ['EXPECTED_PAYLOAD_SHA256'] = '0' * 64
                if change == 'source':os.environ['EXPECTED_SHA'] = 'b' * 40
                if change == 'tag':os.environ['RELEASE_DIST_TAG'] = 'next'
                if change == 'version':os.environ['EXPECTED_VERSION'] = '0.1.1'
                if change == 'event':os.environ['GITHUB_EVENT_NAME'] = 'push'
                if change == 'dry':os.environ['DRY_RUN'] = 'false'
                with self.assertRaises(ValueError):h.capture()
                self.assertFalse((h.OUT / h.RECEIPT).exists())

    def test_download_requires_successful_same_source_workflow_and_unique_retained_artifact(self):
        cases = ['failed', 'wrongsha', 'wrongworkflow', 'wrongrepo', 'notmanual', 'incomplete', 'missing', 'expired', 'duplicate', 'artifactsource', 'wronghash', 'wrongreceipt', 'badid']
        for case in cases:
            with self.subTest(case=case), fixture() as (root, raw, sha):
                receipt = capture();api, replies = proof(sha, receipt, raw);shutil.rmtree(h.OUT)
                run = replies[f'repos/{h.REPOSITORY}/actions/runs/123'];listing = replies[f'repos/{h.REPOSITORY}/actions/runs/123/artifacts?per_page=100'];a = listing['artifacts'][0]
                if case == 'failed':run['conclusion'] = 'failure'
                if case == 'wrongsha':run['head_sha'] = 'b' * 40
                if case == 'wrongworkflow':run['path'] = '.github/workflows/other.yml'
                if case == 'wrongrepo':run['head_repository']['full_name'] = 'foreign/repo'
                if case == 'notmanual':run['event'] = 'push'
                if case == 'incomplete':run['status'] = 'in_progress'
                if case == 'missing':listing['artifacts'] = []
                if case == 'expired':a['expired'] = True
                if case == 'duplicate':listing['artifacts'].append(copy.deepcopy(a))
                if case == 'artifactsource':a['workflow_run']['head_sha'] = 'b' * 40
                if case == 'wronghash':os.environ['EXPECTED_PAYLOAD_SHA256'] = 'b' * 64
                if case == 'wrongreceipt':os.environ['EXPECTED_RECEIPT_SHA256'] = 'b' * 64
                if case == 'badid':os.environ['PROOF_RUN_ID'] = '../123'
                with patch.object(h, 'api', side_effect=api), self.assertRaises(ValueError):h.download()

    def test_receipt_cannot_authorize_other_tag_version_run_or_source_content(self):
        for field, value in [('distTag', 'next'), ('version', '0.1.1'), ('runId', '999'), ('sourceCommit', 'b' * 40), ('sourceFiles', {})]:
            with self.subTest(field=field), fixture():
                capture();r = json.loads((h.OUT / h.RECEIPT).read_text());r[field] = value
                (h.OUT / h.RECEIPT).write_text(json.dumps(r));os.environ['EXPECTED_RECEIPT_SHA256'] = h.digest((h.OUT / h.RECEIPT).read_bytes())
                with self.assertRaises(ValueError):h.verify()

    def test_exact_downloaded_approved_archive_is_the_only_npm_write(self):
        with fixture() as (root, raw, sha):
            api, replies = downloaded(sha, raw);writes = [];original = subprocess.run
            def run(args, **kwargs):
                if args[:2] != ['npm', 'publish']:return original(args, **kwargs)
                writes.append(args);self.assertEqual(Path(args[2]).read_bytes(), raw)
                self.assertEqual(args[2], str((h.OUT / h.TGZ).resolve()));self.assertNotIn('--workspace', args)
                self.assertEqual(args[args.index('--tag') + 1], 'latest')
                self.assertEqual(kwargs['env']['NODE_AUTH_TOKEN'], 'offline-placeholder');self.assertNotIn('GH_TOKEN', kwargs['env'])
                self.assertEqual(Path(args[args.index('--userconfig') + 1]).read_text(), '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n')
                self.assertNotIn('offline-placeholder', Path(args[args.index('--userconfig') + 1]).read_text())
                return subprocess.CompletedProcess(args, 0)
            with patch.object(h, 'api', side_effect=api) as calls, patch.object(h.subprocess, 'run', side_effect=run), self.assertRaises(SystemExit) as result:h.publish()
            self.assertEqual(result.exception.code, 0);self.assertEqual(len(writes), 1)
            self.assertEqual(calls.call_count, 3, 'rechecks successful GitHub proof/run AND body before write')

    def test_forged_local_download_selection_cannot_substitute_for_remote_proof_body(self):
        for member in [h.TGZ, h.RECEIPT]:
            with self.subTest(member=member), fixture() as (root, raw, sha):
                receipt = capture();api, replies = proof(sha, receipt, raw)
                # Deliberately NEVER call download(): local files/selection alone
                # are not a successful remote proof body, even if owner hashes match.
                Path('artifact-selection.json').write_text(json.dumps({'runId': '123', 'artifactId': 456, 'name': f'{h.ARTIFACT}-{sha}-123', 'sourceCommit': sha}))
                Path('registry-before.json').write_text(json.dumps({'tags': {}, 'versionAbsent': h.VERSION, 'packageAbsent': True, 'route': h.ROUTE}))
                other = io.BytesIO()
                with zipfile.ZipFile(other, 'w') as zipped:
                    zipped.writestr(h.TGZ, raw if member != h.TGZ else b'different remote archive')
                    zipped.writestr(h.RECEIPT, receipt if member != h.RECEIPT else b'different remote receipt')
                replies[f'repos/{h.REPOSITORY}/actions/artifacts/456/zip'] = other.getvalue()
                writes = [];original = subprocess.run
                def run(args, **kwargs):
                    if args[:2] == ['npm', 'publish']:writes.append(args);raise AssertionError('Must not write')
                    return original(args, **kwargs)
                with patch.object(h, 'api', side_effect=api), patch.object(h.subprocess, 'run', side_effect=run), self.assertRaisesRegex(ValueError, 'proof body hash mismatch'):
                    h.publish()
                self.assertEqual(writes, [])

    def test_missing_bootstrap_credential_and_unresolved_registry_fail_before_npm(self):
        with fixture() as (root, raw, sha):
            downloaded(sha, raw)
            os.environ.pop('NODE_AUTH_TOKEN')
            with patch.object(h, 'registry_read') as read, self.assertRaisesRegex(ValueError, 'bootstrap credential is missing'):
                h.preflight()
            read.assert_not_called()
        for response in [(0, {}), (1, {'error': {'code': 'E401'}}), (1, {'error': {'code': 'ETIMEDOUT'}})]:
            with self.subTest(response=response), fixture():
                capture()
                with patch.object(h, 'registry_read', return_value=response), self.assertRaisesRegex(ValueError, 'absence is unresolved'):
                    h.preflight()
                self.assertFalse(Path('registry-before.json').exists())

    def test_publish_rejects_archive_receipt_source_proof_and_artifact_drift_before_write(self):
        cases = ['archive', 'receipt', 'source', 'missingselection', 'wrongselection', 'failedproof', 'artifactexpired', 'artifactsource', 'wrongrun', 'dry']
        for case in cases:
            with self.subTest(case=case), fixture() as (root, raw, sha):
                api, replies = downloaded(sha, raw)
                if case == 'archive':(h.OUT / h.TGZ).write_bytes(raw + b'drift')
                if case == 'receipt':(h.OUT / h.RECEIPT).write_bytes(b'{}')
                if case == 'source':Path(h.PACKAGE, 'source.ts').write_text('changed source')
                if case == 'missingselection':Path('artifact-selection.json').unlink()
                if case == 'wrongselection':Path('artifact-selection.json').write_text('{}')
                if case == 'failedproof':replies[f'repos/{h.REPOSITORY}/actions/runs/123']['conclusion'] = 'failure'
                if case == 'artifactexpired':replies[f'repos/{h.REPOSITORY}/actions/artifacts/456']['expired'] = True
                if case == 'artifactsource':replies[f'repos/{h.REPOSITORY}/actions/artifacts/456']['workflow_run']['head_sha'] = 'b' * 40
                if case == 'wrongrun':os.environ['PROOF_RUN_ID'] = '999'
                if case == 'dry':os.environ['DRY_RUN'] = 'true'
                writes = [];original = subprocess.run
                def run(args, **kwargs):
                    if args[:2] == ['npm', 'publish']:writes.append(args);raise AssertionError('Must not write')
                    return original(args, **kwargs)
                with patch.object(h, 'api', side_effect=api), patch.object(h.subprocess, 'run', side_effect=run), self.assertRaises((ValueError, FileNotFoundError, subprocess.CalledProcessError)):h.publish()
                self.assertEqual(writes, [])

if __name__ == '__main__':
    unittest.main()
