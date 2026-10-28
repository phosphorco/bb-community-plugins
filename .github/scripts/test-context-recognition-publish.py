"""Offline checks for the CR-only tokenless workflow branch; never publishes."""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / 'workflows' / 'publish.yml'
TEXT = WORKFLOW.read_text()
STEPS = dict(re.findall(r'^      - name: ([^\n]+)\n(.*?)(?=^      - name: |\Z)', TEXT, re.M | re.S))
CR = STEPS['Publish context recognition through trusted publisher']
REGULAR = STEPS['Publish public package']
PINNED = STEPS['Publish only the reviewed pinned-next tgz']
BOOTSTRAP = STEPS['Bootstrap membership from the reviewed tgz']


def selected(step, *, plugin, dry=False, pinned=False, route='oidc'):
    condition = re.search(r'^        if: \$\{\{ (.+) \}\}', step, re.M).group(1)
    values = {
        'inputs.dry_run': dry,
        'steps.release.outputs.plugin': plugin,
        'steps.release.outputs.pinned_next': 'true' if pinned else 'false',
        'steps.release.outputs.pinned_route': route,
    }
    for name, value in values.items():
        condition = condition.replace(name, repr(value))
    condition = condition.replace('&&', ' and ').replace('||', ' or ')
    condition = re.sub(r'!(?!=)', 'not ', condition)
    # All inputs above are fixed test cases; GitHub expressions are never executed as shell.
    return eval(condition, {'__builtins__': {}}, {})


class TrustedRecognitionPublishing(unittest.TestCase):
    def test_exact_package_has_one_tokenless_branch(self):
        self.assertTrue(selected(CR, plugin='bb-context-recognition'))
        self.assertFalse(selected(REGULAR, plugin='bb-context-recognition'))
        self.assertFalse(selected(PINNED, plugin='bb-context-recognition'))
        self.assertIn("NODE_AUTH_TOKEN: ''", CR)
        self.assertNotIn('secrets.', CR)
        self.assertIn("test \"$RELEASE_WORKSPACE\" = '@phosphorco/bb-context-recognition'", CR)

    def test_other_packages_keep_regular_token_behavior(self):
        for plugin in ['bb-identity', 'bb-cross-references', 'bb-provider-settings', 'perspectives', 'bb-context-recognition-other']:
            with self.subTest(plugin=plugin):
                self.assertFalse(selected(CR, plugin=plugin))
                self.assertTrue(selected(REGULAR, plugin=plugin))
        self.assertIn('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}', REGULAR)

    def test_dry_run_never_publishes(self):
        for plugin in ['bb-context-recognition', 'bb-identity', 'bb-thread-membership', 'perspectives']:
            for step in [CR, REGULAR, PINNED, BOOTSTRAP]:
                for route in ['oidc', 'membership-bootstrap']:
                    self.assertFalse(selected(step, plugin=plugin, dry=True, pinned=True, route=route))

    def test_identity_pinned_path_is_unchanged_and_exclusive(self):
        self.assertTrue(selected(PINNED, plugin='bb-identity', pinned=True))
        self.assertFalse(selected(CR, plugin='bb-identity', pinned=True))
        self.assertFalse(selected(REGULAR, plugin='bb-identity', pinned=True))
        self.assertIn('bb-identity-next-release.py preflight', PINNED)
        self.assertIn('bb-identity-next-release.py postflight', PINNED)

    def test_membership_bootstrap_is_the_only_token_route_for_the_pinned_row(self):
        self.assertTrue(selected(BOOTSTRAP, plugin='bb-thread-membership', pinned=True, route='membership-bootstrap'))
        for step in [CR, REGULAR, PINNED]:
            self.assertFalse(selected(step, plugin='bb-thread-membership', pinned=True, route='membership-bootstrap'))
        for plugin in ['bb-identity', 'bb-context-recognition', 'perspectives']:
            self.assertFalse(selected(BOOTSTRAP, plugin=plugin, pinned=True, route='membership-bootstrap'))
        self.assertFalse(selected(BOOTSTRAP, plugin='bb-thread-membership', pinned=True))
        self.assertIn('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}', BOOTSTRAP)
        self.assertNotIn('secrets.', PINNED)

    def test_supported_oidc_workflow_prerequisites(self):
        self.assertRegex(TEXT, r'(?m)^  id-token: write$')
        self.assertIn('runs-on: ubuntu-latest', TEXT)
        self.assertIn('node-version: "24"', TEXT)
        self.assertIn('npm install -g npm@^11.5.1', TEXT)
        self.assertNotIn('environment:', TEXT)

    def test_real_publish_shell_exact_workspace_and_failure_propagation(self):
        script = re.search(r'^        run: \|\n(.*?)(?=^        env:)', CR, re.M | re.S).group(1)
        script = '\n'.join(line[10:] for line in script.splitlines())
        with tempfile.TemporaryDirectory(prefix='cr-publish-test-') as directory:
            root = Path(directory)
            npm = root / 'npm'
            npm.write_text('#!/usr/bin/env python3\nimport os,json,sys\nopen(os.environ["CALL_RECEIPT"],"w").write(json.dumps({"args":sys.argv[1:],"token":os.environ.get("NODE_AUTH_TOKEN")}))\nsys.exit(int(os.environ.get("FAKE_NPM_EXIT","0")))\n')
            npm.chmod(0o700)
            receipt = root / 'called.json'
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'NODE_AUTH_TOKEN': '', 'RELEASE_WORKSPACE': '@phosphorco/bb-context-recognition', 'RELEASE_DIST_TAG': 'next', 'CALL_RECEIPT': str(receipt)}
            result = subprocess.run(['bash', '-e', '-c', script], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            called = json.loads(receipt.read_text())
            self.assertEqual(called['token'], '')
            self.assertEqual(called['args'], ['publish','--ignore-scripts','--access','public','--provenance','--workspace','@phosphorco/bb-context-recognition','--tag','next'])
            receipt.unlink()
            result = subprocess.run(['bash', '-e', '-c', script], env={**env,'RELEASE_WORKSPACE':'@phosphorco/bb-identity'}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(receipt.exists())
            result = subprocess.run(['bash', '-e', '-c', script], env={**env,'FAKE_NPM_EXIT':'42'}, capture_output=True)
            self.assertEqual(result.returncode, 42)


if __name__ == '__main__':
    unittest.main()
