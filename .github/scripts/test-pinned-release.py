"""Offline checks for the closed pinned-release table (helper + select step); never publishes or calls a network."""
from pathlib import Path
import importlib.util
import os
import json
import hashlib
from unittest.mock import patch
from contextlib import contextmanager
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / '.github/workflows/publish.yml').read_text()
STEPS = dict(re.findall(r'^      - name: ([^\n]+)\n(.*?)(?=^      - name: |\Z)', WORKFLOW, re.M | re.S))
SELECT = STEPS['Select and verify the release source']
SCRIPT = '\n'.join(line[10:] for line in re.search(r'^        run: \|\n(.*)', SELECT, re.M | re.S).group(1).splitlines())
SHA = 'a' * 40
spec = importlib.util.spec_from_file_location('helper', ROOT / '.github/scripts/bb-identity-next-release.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def select(*, plugin, version, event='workflow_dispatch', tag='latest', dry=True, expected_version=None, hashes=False):
    # Stub npm/git as shell functions (no executable files are written or exec'd).
    stubs = ('npm() { printf \'{"w":"%s"}\' "$FAKE_VERSION"; }\n'
             'git() { case "$*" in "rev-parse HEAD") echo "$FAKE_SHA";; *"refs/tags/"*) return 1;; *) return 0;; esac; }\n')
    with tempfile.TemporaryDirectory(prefix='pinned-select-') as directory:
        output = Path(directory) / 'out'
        env = {'PATH': os.environ['PATH'], 'FAKE_VERSION': version, 'FAKE_SHA': SHA,
               'REQUESTED_PLUGIN': plugin, 'REQUESTED_DIST_TAG': tag, 'DRY_RUN': 'true' if dry else 'false',
               'GITHUB_EVENT_NAME': event, 'GITHUB_REF_NAME': f'{plugin}/v{version}', 'GITHUB_SHA': SHA, 'GITHUB_OUTPUT': str(output),
               'EXPECTED_SHA': SHA, 'EXPECTED_VERSION': expected_version or version}
        if hashes:
            env.update(PROOF_RUN_ID='123', EXPECTED_PAYLOAD_SHA256='b' * 64, EXPECTED_RECEIPT_SHA256='c' * 64)
        result = subprocess.run(['bash', '-e', '-c', stubs + SCRIPT], env=env, capture_output=True, text=True)
        values = dict(line.split('=', 1) for line in output.read_text().splitlines()) if output.exists() else {}
        values.setdefault('pinned_next', f'<no output; exit {result.returncode}: {result.stderr.strip()[-300:]}>')
        return result.returncode, values, result.stderr


class PinnedTable(unittest.TestCase):
    def test_table_is_closed_and_exact(self):
        self.assertEqual(set(helper.PINNED), {('bb-identity', '0.4.0'), ('bb-identity', '0.4.1'), ('bb-identity', '0.4.2-native-marker.0'), ('bb-thread-membership', '0.1.0'), ('bb-identity', '0.5.0')})
        for plugin, version in [('perspectives', '0.3.0'), ('bb-identity', '0.3.1'), ('bb-context-recognition', '0.6.0'), ('bb-thread-membership', '0.1.1')]:
            with self.assertRaises(ValueError):
                helper.bind(plugin, version)
        self.assertRegex(SELECT, r'bb-identity@0\.4\.0\|bb-identity@0\.4\.1\|bb-identity@0\.4\.2-native-marker\.0\|bb-identity@0\.5\.0\|bb-thread-membership@0\.1\.0\) pinned_row=true')

    def test_identity_040_row_keeps_original_names_and_next(self):
        helper.bind('bb-identity', '0.4.0')
        self.assertEqual((helper.PACKAGE, helper.NAME, helper.DIST_TAG, helper.ROUTE, helper.TGZ, helper.ARTIFACT),
                         ('packages/bb-identity', '@phosphorco/bb-identity', 'next', 'oidc', 'phosphorco-bb-identity-0.4.0.tgz', 'bb-identity-next'))

    def test_new_rows_have_exact_tag_and_separate_route(self):
        with patch.dict(os.environ, {}, clear=True):
            helper.bind('bb-identity', '0.5.0')
            self.assertEqual((helper.DIST_TAG, helper.ROUTE), ('next', 'oidc'))
            helper.publishable()
            os.environ['RELEASE_DIST_TAG'] = 'latest'
            with self.assertRaisesRegex(ValueError, 'differs from the reviewed row'):
                helper.publishable()
            os.environ['RELEASE_DIST_TAG'] = 'latest'
            helper.bind('bb-thread-membership', '0.1.0')
            with self.assertRaisesRegex(ValueError, 'bootstrap credential is missing'):
                helper.publishable()
            os.environ['NODE_AUTH_TOKEN'] = 'offline-placeholder'
            self.assertEqual((helper.DIST_TAG, helper.ROUTE), ('latest', 'membership-bootstrap'))
            helper.publishable()


class SelectStep(unittest.TestCase):
    def test_identity_040_selection_is_unchanged(self):
        code, out, _ = select(plugin='bb-identity', version='0.4.0', tag='next', dry=True)
        self.assertEqual((code, out['pinned_next'], out['pinned_artifact'], out['pinned_tgz']), (0, 'true', 'bb-identity-next-' + SHA, 'phosphorco-bb-identity-0.4.0.tgz'))
        code, out, _ = select(plugin='bb-identity', version='0.4.0', tag='latest', dry=True)
        self.assertEqual((code, out['pinned_next']), (0, 'false'))
        code, _, err = select(plugin='bb-identity', version='0.4.0', tag='latest', dry=False)
        self.assertNotEqual(code, 0)
        self.assertIn('automatic/default publication refused', err)
        code, _, _ = select(plugin='bb-identity', version='0.3.1', tag='next', dry=True)
        self.assertNotEqual(code, 0)

    def test_new_rows_pin_on_dispatch_and_refuse_elsewhere(self):
        for plugin, version, tag in [('bb-identity', '0.5.0', 'next'), ('bb-thread-membership', '0.1.0', 'latest')]:
            code, out, _ = select(plugin=plugin, version=version, tag=tag)
            self.assertEqual((code, out['pinned_next']), (0, 'true'))
            self.assertEqual(out['pinned_tgz'], 'phosphorco-' + plugin + '-' + version + '.tgz')
            code, _, err = select(plugin=plugin, version=version, event='push', tag=tag, dry=False)
            self.assertNotEqual(code, 0)
            self.assertIn('automatic/default publication refused', err)
            code, _, err = select(plugin=plugin, version=version, tag=tag, dry=False)
            self.assertNotEqual(code, 0)
            self.assertIn('Reviewed dry-run ID and payload/receipt hashes required', err)
            code, out, _ = select(plugin=plugin, version=version, tag=tag, dry=False, hashes=True)
            self.assertEqual((code, out['pinned_next']), (0, 'true'))
            code, _, _ = select(plugin=plugin, version=version, tag=tag, expected_version='wrong')
            self.assertNotEqual(code, 0)
        self.assertNotEqual(select(plugin='bb-identity', version='0.5.0', tag='latest')[0], 0)
        self.assertNotEqual(select(plugin='bb-thread-membership', version='0.1.0', tag='next')[0], 0)

    def test_all_old_identity_rows_keep_guards_and_artifact_names(self):
        for version in ['0.4.0', '0.4.1', '0.4.2-native-marker.0']:
            code, out, _ = select(plugin='bb-identity', version=version, tag='next', dry=False, hashes=True)
            self.assertEqual((code, out['pinned_artifact'], out['pinned_publication']), (0, 'bb-identity-next-' + SHA, 'bb-identity-next-publication'))
            self.assertEqual(out['pinned_tgz'], 'phosphorco-bb-identity-' + version + '.tgz')
            self.assertNotEqual(select(plugin='bb-identity', version=version, tag='latest', dry=False)[0], 0)
            self.assertNotEqual(select(plugin='bb-identity', version=version, tag='next', dry=False)[0], 0)

    def test_unrelated_and_older_versions_keep_the_regular_path(self):
        for plugin, version in [('perspectives', '0.3.0'), ('bb-context-recognition', '0.5.0'), ('bb-context-recognition', '0.6.0'), ('bb-cross-references', '0.2.0'), ('people-accounts', '0.1.0'), ('bb-people-accounts', '0.1.0')]:
            code, out, _ = select(plugin=plugin, version=version, dry=True)
            self.assertEqual((code, out['pinned_next']), (0, 'false'), plugin)

    def test_pinned_steps_take_names_and_row_from_selection(self):
        self.assertIn('name: ${{ steps.release.outputs.pinned_artifact }}-${{ github.run_id }}', WORKFLOW)
        self.assertIn('release-candidate/${{ steps.release.outputs.pinned_tgz }}', WORKFLOW)
        self.assertIn('name: ${{ steps.release.outputs.pinned_publication }}-${{ github.run_id }}', WORKFLOW)
        publish = STEPS['Publish only the reviewed pinned-next tgz']
        self.assertIn("NODE_AUTH_TOKEN: ''", publish)
        self.assertIn('RELEASE_PLUGIN: ${{ steps.release.outputs.plugin }}', publish)
        self.assertNotIn('secrets.', publish)
        bootstrap = STEPS['Bootstrap membership from the reviewed tgz']
        self.assertIn("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}", bootstrap)
        self.assertIn("steps.release.outputs.plugin == 'bb-thread-membership'", bootstrap)
        self.assertIn("steps.release.outputs.pinned_route == 'membership-bootstrap'", bootstrap)
        for step in [publish, bootstrap]:
            self.assertIn('bb-identity-next-release.py preflight', step)
            self.assertIn('bb-identity-next-release.py postflight', step)
            self.assertEqual(step.count('bb-identity-next-release.py publish >'), 1)
            self.assertNotIn('npm pack', step)
            self.assertNotIn('npm run build', step)
            self.assertIn('!inputs.dry_run', step)
        self.assertEqual(WORKFLOW.count('npm pack --ignore-scripts --json --workspace "$RELEASE_WORKSPACE"'), 1)


@contextmanager
def fixture(plugin='bb-thread-membership', version='0.1.0', tags='{}'):
    helper.bind(plugin, version)
    original = Path.cwd()
    with tempfile.TemporaryDirectory(prefix='pinned-helper-test-') as directory:
        os.chdir(directory)
        try:
            with patch.dict(os.environ, {'PATH': os.environ['PATH'], 'EXPECTED_PREFLIGHT_TAGS': tags,
                                         'RELEASE_DIST_TAG': helper.DIST_TAG, 'DRY_RUN': 'false',
                                         'NODE_AUTH_TOKEN': 'offline-placeholder'}, clear=True):
                yield Path(directory)
        finally:
            os.chdir(original)


def missing():
    return (1, {'error': {'code': 'E404', 'summary': 'Not Found - GET https://registry.npmjs.org/@phosphorco%2fbb-thread-membership - Not found'}})


class FirstPublishPreflight(unittest.TestCase):
    def test_only_exact_package_e404_plus_approved_empty_tags_admits_bootstrap(self):
        with fixture(), patch.object(helper, 'verify'), patch.object(helper, 'registry_read', side_effect=[missing(), missing()]) as read:
            helper.preflight()
            before = json.loads(Path('registry-before.json').read_text())
            self.assertEqual(before, {'tags': {}, 'versionAbsent': '0.1.0', 'packageAbsent': True, 'route': 'membership-bootstrap'})
            self.assertEqual(read.call_args_list[0].args, ('@phosphorco/bb-thread-membership', 'dist-tags'))
            self.assertEqual(read.call_args_list[1].args, ('@phosphorco/bb-thread-membership@0.1.0', 'version'))

    def test_exists_auth_network_malformed_or_wrong_package_are_not_absence(self):
        cases = [(0, {}), (0, {'latest': '0.1.0'}), (1, {}), (1, {'error': {'code': 'E404'}})]
        for code in ['E401', 'E403', 'ENOTFOUND', 'ETIMEDOUT']:
            cases.append((1, {'error': {'code': code}}))
        cases.append((1, {'error': {'code': 'E404', 'summary': 'Not Found - GET https://registry.npmjs.org/@other%2fpackage - Not found'}}))
        for result in cases:
            with self.subTest(result=result), fixture(), patch.object(helper, 'verify'), patch.object(helper, 'registry_read', return_value=result):
                with self.assertRaisesRegex(ValueError, 'absence is unresolved'):
                    helper.preflight()
                self.assertFalse(Path('registry-before.json').exists())

    def test_version_also_must_be_absent_and_tags_explicitly_empty(self):
        for tags, replies in [('{}', [missing(), (0, '0.1.0')]), ('{"latest":"0.0.1"}', [missing()])]:
            with fixture(tags=tags), patch.object(helper, 'verify'), patch.object(helper, 'registry_read', side_effect=replies):
                with self.assertRaises(ValueError):
                    helper.preflight()
                self.assertFalse(Path('registry-before.json').exists())

    def test_missing_bootstrap_credential_fails_before_any_network(self):
        with fixture(), patch.object(helper, 'registry_read') as read, patch.object(helper, 'verify'):
            os.environ.pop('NODE_AUTH_TOKEN')
            with self.assertRaisesRegex(ValueError, 'bootstrap credential is missing'):
                helper.preflight()
            read.assert_not_called()

    def test_identity_050_requires_existing_exact_tags_and_preserves_latest(self):
        approved = {'latest': '0.3.1', 'next': '0.4.2-native-marker.0', 'other': '0.2.0'}
        with fixture('bb-identity', '0.5.0', json.dumps(approved)), patch.object(helper, 'verify'), patch.object(helper, 'registry_read', side_effect=[(0, approved), (1, {'error': {'code': 'E404'}})]):
            helper.preflight()
            self.assertEqual(json.loads(Path('registry-before.json').read_text())['tags'], approved)
        for tags in [{}, {'latest': '0.4.0'}]:
            with fixture('bb-identity', '0.5.0', json.dumps(tags)), patch.object(helper, 'verify'), patch.object(helper, 'registry_read', return_value=(0, tags)):
                with self.assertRaises(ValueError):
                    helper.preflight()

    def test_registry_read_is_fresh_and_has_no_network_retry(self):
        source = (ROOT / '.github/scripts/bb-identity-next-release.py').read_text()
        self.assertIn("'--prefer-online', '--fetch-retries=0', '--fetch-timeout=15000'", source)


class ExactPublishRoutes(unittest.TestCase):
    def prepare(self):
        Path(helper.PACKAGE).mkdir(parents=True)
        Path(helper.PACKAGE, 'package.json').write_text('{"publishConfig":{"access":"public"}}')
        helper.OUT.mkdir()
        archive = helper.OUT / helper.TGZ
        archive.write_bytes(b'offline-reviewed-archive')
        os.environ['EXPECTED_PAYLOAD_SHA256'] = helper.digest(archive.read_bytes())
        Path('registry-before.json').write_text(json.dumps({'tags': {}, 'versionAbsent': helper.VERSION, 'packageAbsent': True, 'route': helper.ROUTE}))
        return archive.resolve()

    def test_identity_strips_all_npm_credentials_and_uses_exact_tgz_once(self):
        with fixture('bb-identity', '0.5.0'):
            archive = self.prepare()
            os.environ.update(NPM_TOKEN='offline-other', NPM_AUTH_TOKEN='offline-other', npm_config_registry='https://wrong.invalid', NPM_PASSWORD='offline-other')
            seen = []
            def run(args, **kwargs):
                seen.append(args)
                env = kwargs['env']
                self.assertEqual(env['NODE_AUTH_TOKEN'], '')
                self.assertEqual(env['NPM_TOKEN'], '')
                self.assertNotIn('NPM_AUTH_TOKEN', env)
                self.assertNotIn('NPM_PASSWORD', env)
                self.assertFalse(any(k.lower().startswith('npm_config_') for k in env))
                self.assertEqual(Path(args[args.index('--userconfig') + 1]).read_text(), '')
                self.assertEqual(Path(args[args.index('--globalconfig') + 1]).read_text(), '')
                self.assertEqual(args[:3], ['npm', 'publish', str(archive)])
                self.assertEqual(args[args.index('--tag') + 1], 'next')
                self.assertIn('--ignore-scripts', args)
                self.assertIn('--provenance', args)
                return subprocess.CompletedProcess(args, 42)
            with patch.object(helper.subprocess, 'run', side_effect=run), self.assertRaises(SystemExit) as result:
                helper.publish()
            self.assertEqual(result.exception.code, 42)
            self.assertEqual(len(seen), 1)

    def test_membership_only_injects_bootstrap_into_isolated_literal_npmrc(self):
        with fixture():
            archive = self.prepare()
            def run(args, **kwargs):
                self.assertEqual(args[:3], ['npm', 'publish', str(archive)])
                self.assertEqual(args[args.index('--tag') + 1], 'latest')
                self.assertEqual(kwargs['env']['NODE_AUTH_TOKEN'], 'offline-placeholder')
                self.assertEqual(kwargs['env']['NPM_TOKEN'], '')
                user = Path(args[args.index('--userconfig') + 1])
                self.assertEqual(user.read_text(), '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n')
                self.assertEqual(user.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('offline-placeholder', user.read_text())
                return subprocess.CompletedProcess(args, 0)
            with patch.object(helper.subprocess, 'run', side_effect=run) as called, self.assertRaises(SystemExit) as result:
                helper.publish()
            self.assertEqual(result.exception.code, 0)
            self.assertEqual(called.call_count, 1)

    def test_no_publish_on_dryrun_missing_preflight_or_payload_drift(self):
        for case in ['dry', 'missing', 'drift']:
            with self.subTest(case=case), fixture():
                archive = self.prepare()
                if case == 'dry':
                    os.environ['DRY_RUN'] = 'true'
                elif case == 'missing':
                    Path('registry-before.json').unlink()
                else:
                    archive.write_bytes(b'drift')
                with patch.object(helper.subprocess, 'run') as called, self.assertRaises((ValueError, FileNotFoundError)):
                    helper.publish()
                called.assert_not_called()

    def test_postflight_records_both_reads_even_if_uncertain_and_never_retries(self):
        for plugin, version, tags in [('bb-identity', '0.5.0', {'latest': '0.3.1', 'next': '0.4.2-native-marker.0'}), ('bb-thread-membership', '0.1.0', {})]:
            with fixture(plugin, version):
                helper.OUT.mkdir()
                (helper.OUT / helper.RECEIPT).write_text('{"payload":{"integrity":"sri","shasum":"sha1"}}')
                Path('registry-before.json').write_text(json.dumps({'tags': tags}))
                with patch.object(helper, 'verify'), patch.object(helper, 'registry_read', side_effect=[missing(), missing()]) as read, self.assertRaisesRegex(ValueError, 'inspect without retry'):
                    helper.postflight()
                self.assertEqual(read.call_count, 2)
                after = json.loads(Path('registry-after.json').read_text())
                self.assertEqual(after['tagsRead']['exitCode'], 1)
                self.assertEqual(after['distRead']['exitCode'], 1)

    def test_postflight_accepts_only_the_one_approved_tag_effect(self):
        for plugin, version, before in [('bb-identity', '0.5.0', {'latest': '0.3.1', 'next': '0.4.2-native-marker.0'}), ('bb-thread-membership', '0.1.0', {})]:
            with fixture(plugin, version):
                helper.OUT.mkdir()
                (helper.OUT / helper.RECEIPT).write_text('{"payload":{"integrity":"sri","shasum":"sha1"}}')
                Path('registry-before.json').write_text(json.dumps({'tags': before}))
                after = {**before, helper.DIST_TAG: version}
                with patch.object(helper, 'verify'), patch.object(helper, 'registry_read', side_effect=[(0, after), (0, {'integrity': 'sri', 'shasum': 'sha1'})]):
                    helper.postflight()
                after['unapproved'] = version
                with patch.object(helper, 'verify'), patch.object(helper, 'registry_read', side_effect=[(0, after), (0, {'integrity': 'sri', 'shasum': 'sha1'})]), self.assertRaises(ValueError):
                    helper.postflight()


class ReviewedPayload(unittest.TestCase):
    def prepare(self):
        import io, tarfile, base64
        Path(helper.PACKAGE).mkdir(parents=True)
        manifest = {'name': helper.NAME, 'version': helper.VERSION, 'exports': {'.': {'default': './dist/index.js'}}, 'publishConfig': {'access': 'public'}}
        Path(helper.PACKAGE, 'package.json').write_text(json.dumps(manifest))
        helper.OUT.mkdir()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as t:
            for name, data in [('package/package.json', json.dumps(manifest).encode()), ('package/dist/index.js', b'export const version = 1;')]:
                m = tarfile.TarInfo(name);m.size = len(data);m.mode = 0o644
                t.addfile(m, io.BytesIO(data))
        raw = stream.getvalue()
        (helper.OUT / helper.TGZ).write_bytes(raw)
        (helper.OUT / 'pack.json').write_text(json.dumps([{'filename': helper.TGZ, 'shasum': hashlib.sha1(raw).hexdigest(), 'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()}]))
        os.environ.update(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', PROOF_RUN_ID='123')
        return raw

    def freeze(self):
        os.environ['EXPECTED_PAYLOAD_SHA256'] = helper.digest((helper.OUT / helper.TGZ).read_bytes())
        os.environ['EXPECTED_RECEIPT_SHA256'] = helper.digest((helper.OUT / helper.RECEIPT).read_bytes())

    def test_capture_then_verify_exact_archive_and_source_for_both_new_rows(self):
        for plugin, version in [('bb-identity', '0.5.0'), ('bb-thread-membership', '0.1.0')]:
            with fixture(plugin, version), patch.object(helper, 'expected', return_value=SHA), patch.object(helper, 'sources', return_value={'source': 'hash'}), patch.object(helper, 'command', return_value='tree'):
                raw = self.prepare()
                helper.capture();self.freeze();helper.verify()
                receipt = json.loads((helper.OUT / helper.RECEIPT).read_text())
                self.assertEqual(receipt['package'], helper.NAME)
                self.assertEqual(receipt['distTag'], helper.DIST_TAG)
                self.assertEqual(receipt['payload']['sha256'], helper.digest(raw))
                self.assertEqual(receipt['payload']['archive'], helper.TGZ)
                self.assertTrue(receipt['dryRun'])
                self.assertEqual(len(receipt['payload']['files']), 2)

    def test_reviewed_hash_manifest_export_and_source_drift_are_refused(self):
        with fixture(), patch.object(helper, 'expected', return_value=SHA), patch.object(helper, 'sources', return_value={'source': 'hash'}), patch.object(helper, 'command', return_value='tree'):
            raw = self.prepare();helper.capture();self.freeze()
            archive = helper.OUT / helper.TGZ
            archive.write_bytes(raw + b'drift')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                helper.verify()
            archive.write_bytes(raw)
            with patch.object(helper, 'sources', return_value={'source': 'changed'}), self.assertRaisesRegex(ValueError, 'source content drift'):
                helper.verify()
            manifest = Path(helper.PACKAGE, 'package.json')
            saved = manifest.read_text();changed = json.loads(saved);changed['version'] = '0.1.1';manifest.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, 'Payload manifest differs'):
                helper.payload(archive)
            manifest.write_text(saved)
            receipt = json.loads((helper.OUT / helper.RECEIPT).read_text())
            receipt['distTag'] = 'next';(helper.OUT / helper.RECEIPT).write_text(json.dumps(receipt));self.freeze()
            with self.assertRaisesRegex(ValueError, 'not selected dryrun'):
                helper.verify()

    def test_actual_pinned_phase_skips_install_build_pack_but_dryrun_captures(self):
        def chosen(step, dry, plugin):
            expression = re.search(r'^        if: \$\{\{ (.+) \}\}', STEPS[step], re.M).group(1)
            for name, value in {'inputs.dry_run': dry, 'inputs.plugin': plugin, 'inputs.dist_tag': 'next' if plugin == 'bb-identity' else 'latest', 'github.event_name': 'workflow_dispatch', 'steps.release.outputs.pinned_next': 'true'}.items():
                expression = expression.replace(name, repr(value))
            expression = expression.replace('&&', ' and ').replace('||', ' or ')
            expression = re.sub(r'!(?!=)', 'not ', expression)
            return eval(expression, {'__builtins__': {}}, {})
        for plugin in ['bb-identity', 'bb-thread-membership']:
            for step in ['Acquire the exact fork SDK release artifact', 'Install locked dependencies', 'Build shared packages for tests', 'Test', 'Typecheck', 'Pack the pinned-next dry-run payload once', 'Upload exact pinned-next dry-run payload and receipt']:
                self.assertFalse(chosen(step, False, plugin), step)
                self.assertTrue(chosen(step, True, plugin), step)
            # Libraries are already emitted by the shared build. The generic BB
            # build and npm-pack-dry-run inspection stay off: capture validates
            # the ONE real archive instead of repacking it.
            for step in ['Build BB artifacts', 'Inspect package contents']:
                self.assertFalse(chosen(step, False, plugin))
                self.assertFalse(chosen(step, True, plugin))
            self.assertIn('--workspace packages/bb-identity', STEPS['Build shared packages for tests'])
            self.assertIn('--workspace packages/bb-thread-membership', STEPS['Build shared packages for tests'])
            self.assertTrue(chosen('Download and verify the exact reviewed pinned-next dry-run artifact', False, plugin))
            self.assertFalse(chosen('Download and verify the exact reviewed pinned-next dry-run artifact', True, plugin))


if __name__ == '__main__':
    unittest.main()
