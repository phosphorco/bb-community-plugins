"""Offline enrollment and ordinary tagged release checks. Never publishes."""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PUBLISH = (ROOT / '.github/workflows/publish.yml').read_text()
VALIDATE = (ROOT / '.github/workflows/validate-pull-request.yml').read_text()
STEPS = dict(re.findall(r'^      - name: ([^\n]+)\n(.*?)(?=^      - name: |\Z)', PUBLISH, re.M | re.S))
SELECT = '\n'.join(line[10:] for line in re.search(r'^        run: \|\n(.*)', STEPS['Select and verify the release source'], re.M | re.S).group(1).splitlines())
PACKAGE = 'bb-thread-attachments'
NAME = '@phosphorco/' + PACKAGE
SHA = 'a' * 40


def select(**changes):
    with tempfile.TemporaryDirectory(prefix='attachment-release-') as temporary:
        out = Path(temporary) / 'output'
        env = {**os.environ, 'REQUESTED_PLUGIN': PACKAGE, 'REQUESTED_DIST_TAG': 'latest', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF_NAME': 'main', 'GITHUB_SHA': SHA, 'GITHUB_OUTPUT': str(out), 'DRY_RUN': 'true', 'TAG_PRESENT': 'false', 'SOURCE_DIFF': '0'}
        env.update(changes)
        stubs = ('npm() { printf \'{"w":"0.1.1"}\'; }\n'
                 'git() { case "$*" in *"refs/tags/"*) test "$TAG_PRESENT" = true && echo "' + SHA + '";; "diff --quiet "*) return "$SOURCE_DIFF";; *) return 0;; esac; }\n')
        result = subprocess.run(['bash', '-e', '-c', stubs + SELECT], env=env, capture_output=True, text=True)
        values = dict(line.split('=', 1) for line in out.read_text().splitlines()) if out.exists() else {}
        return result, values


class ThreadAttachmentsRelease(unittest.TestCase):
    def test_enrolled_in_every_explicit_list(self):
        self.assertIn('          - ' + PACKAGE + '\n', PUBLISH)
        self.assertIn('      - "' + PACKAGE + '/v*"', PUBLISH)
        self.assertIn('--workspace packages/' + PACKAGE, STEPS['Build shared packages for tests'])
        self.assertIn('npm run build --workspace ' + NAME, VALIDATE)
        self.assertIn('npm pack --dry-run --ignore-scripts --workspace ' + NAME, VALIDATE)
        manifest = json.loads((ROOT / 'packages' / PACKAGE / 'package.json').read_text())
        self.assertEqual((manifest['name'], manifest['version']), (NAME, '0.1.1'))
        lock = json.loads((ROOT / 'package-lock.json').read_text())['packages']
        self.assertEqual(lock['packages/' + PACKAGE]['version'], '0.1.1')
        self.assertEqual(lock['node_modules/' + NAME]['resolved'], 'packages/' + PACKAGE)

    def test_dry_run_selects_exact_workspace_and_package_path(self):
        result, out = select()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out['workspace'], NAME)
        self.assertEqual(out['path'], 'packages/' + PACKAGE)
        self.assertEqual(out['pinned_next'], 'false')
        self.assertEqual(out['version'], '0.1.1')

    def test_publish_requires_matching_existing_tag_and_source(self):
        result, _ = select(DRY_RUN='false')
        self.assertNotEqual(result.returncode, 0)
        result, _ = select(DRY_RUN='false', TAG_PRESENT='true')
        self.assertEqual(result.returncode, 0, result.stderr)
        result, _ = select(DRY_RUN='false', TAG_PRESENT='true', SOURCE_DIFF='1')
        self.assertNotEqual(result.returncode, 0)
        result, _ = select(GITHUB_EVENT_NAME='push', GITHUB_REF_NAME='wrong/v0.1.1', TAG_PRESENT='true')
        self.assertNotEqual(result.returncode, 0)
        result, _ = select(GITHUB_EVENT_NAME='push', GITHUB_REF_NAME=PACKAGE + '/v0.1.1', TAG_PRESENT='true')
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
