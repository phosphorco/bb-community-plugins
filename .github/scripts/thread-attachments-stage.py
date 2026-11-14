"""One reviewed attachment candidate; one stage submission; never approval.

stdlib only. Importing this module performs no I/O. See docs/releases/
thread-attachments-stage.md for the separate candidate/effect grants.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

REPOSITORY = 'phosphorco/bb-community-plugins'
SOURCE = '93ac7456f429ada7e369aeba89d816928ed05884'
TAG = 'bb-thread-attachments/v0.1.0'
TAG_OBJECT = '1e5212ab73098d70067038eaec5c046c09556f5c'
PACKAGE = '@phosphorco/bb-thread-attachments'
VERSION = '0.1.0'
PACKAGE_PATH = 'packages/bb-thread-attachments'
WORKFLOW = '.github/workflows/stage-thread-attachments.yml'
TOOLING_TAG = 'bb-thread-attachments-stage/workflow-v1'
NPM = '11.19.1'
PRIOR_RUN = 42085600383
PRIOR_CREATED = '2026-11-05T18:34:53Z'
PRIOR_SHA1 = 'bbc44044952a1ab779535c1ad9c5b546562c0160'
TARBALL = 'phosphorco-bb-thread-attachments-0.1.0.tgz'
REGISTRY = 'https://registry.npmjs.org/'
MAX_ARCHIVE = 2_000_000
# Four source blobs at SOURCE and six independently approved emitted entries.
ENTRIES = {
    'CONTRACT.md': (16833, 'a2ed941ee20d6614ec0d8b0a04244ca31a6f1704c2dafbd7c505b730672b3985'),
    'LICENSE': (1065, 'f30ba1b66519792e48d30d250fcc83fc54772a856a5589b7d809701eb5e9b756'),
    'README.md': (3515, '3d9346b90535e8dbe1d564c9a9bc8a7a878bff18ab8a0df2ca888bad07cdc6b9'),
    'package.json': (1899, '456aecd2a776e825c7f8732ea166c95315c10da540fdd3c88d9be7a9d23abe21'),
    'dist/bb.js': (25100, '9d333aeb8c8395909111d9487eddd911b6fc67235cff30f0ba88e919f40d2207'),
    'dist/index.js': (11215, 'ec4d40dbfa6404790d6f8c4bb6159fa5a156b3d4ce1dd4e94b1526fd7b317a85'),
    'dist/testing.js': (4046, '0a7498166ca95abe23577044afca96c41793344d83778271d96bb09c794d0fd4'),
    'dist/types/bb.d.ts': (13437, 'e1a36da2466f65e11a14335833fd83deabca70e48671a6b616f0e4f8169bfbc0'),
    'dist/types/index.d.ts': (8267, '1e890f620d7d73fbe861fe173d9766824ce68f15f5a57caa036c68c98eb9ec04'),
    'dist/types/testing.d.ts': (1553, '37f678a9bc8e81eecd5eb80d2e0dce328415ff28771e25717b4c26f889e3fa3f'),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data, algorithm='sha256'):
    return hashlib.new(algorithm, data).hexdigest()


def write_json(path, value, exclusive=False):
    with Path(path).open('x' if exclusive else 'w') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')


def command(args, cwd=None, timeout=120):
    # No shell, stdin/OTP prompts, or npm transport retries. A timeout on a write
    # is an unknown outcome, never permission to dispatch again.
    env = {**os.environ, 'NPM_CONFIG_FETCH_RETRIES': '0',
           'NPM_CONFIG_REGISTRY': REGISTRY, 'NPM_CONFIG_IGNORE_SCRIPTS': 'true'}
    try:
        result = subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        # Python can return bytes on TimeoutExpired even in text mode. Retain
        # partial diagnostics, applying the same exact credential provenance.
        error.output = redact(error.output, env)
        error.stderr = redact(error.stderr, env)
        raise
    # Preserve nonsecret diagnostics. Mask only actual credential values with
    # explicit environment provenance, including if an error echoes one.
    result.stdout = redact(result.stdout, env)
    result.stderr = redact(result.stderr, env)
    return result


def redact(value, env):
    if isinstance(value, bytes):
        value = value.decode('utf-8', errors='replace')
    value = value or ''
    for name in ('NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'):
        secret = env.get(name)
        if secret:
            value = value.replace(secret, '[credential:' + name + ']')
    return value


def checked(args, cwd=None):
    result = command(args, cwd)
    require(result.returncode == 0, f'{args[:3]} exited {result.returncode}: {result.stderr}')
    return result.stdout.strip()


class CredentialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        require(urllib.parse.urlsplit(url).scheme == 'https', 'Refuse insecure redirect')
        redirected = super().redirect_request(request, fp, code, message, headers, url)
        if urllib.parse.urlsplit(url).netloc != urllib.parse.urlsplit(request.full_url).netloc:
            redirected.remove_header('Authorization')
        return redirected


def github(path, binary=False):
    request = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + '/' + path,
                                    headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                                             'Accept': 'application/vnd.github+json'})
    # Artifact downloads redirect to blob storage. Never forward GH_TOKEN to
    # that different host, including if an upstream redirect is unexpected.
    with urllib.request.build_opener(CredentialRedirect()).open(request, timeout=30) as response:
        data = response.read(10_000_001)
    require(len(data) <= 10_000_000, 'GitHub response too large')
    return data if binary else json.loads(data)


def remote_tag(repo):
    refs = dict(line.split('\t')[::-1] for line in checked([
        'git', 'ls-remote', '--exit-code', 'https://github.com/' + REPOSITORY + '.git',
        'refs/tags/' + TAG, 'refs/tags/' + TAG + '^{}'], repo).splitlines())
    require(refs == {'refs/tags/' + TAG: TAG_OBJECT,
                     'refs/tags/' + TAG + '^{}': SOURCE}, 'Remote annotated tag drift')


def source_fence(repo):
    require(checked(['git', 'rev-parse', 'HEAD'], repo) == SOURCE, 'Package checkout drift')
    # All tracked package/lock bytes must still be reviewed source. dist is
    # untracked build output and is checked separately against ENTRIES.
    require(not checked(['git', 'status', '--porcelain', '--untracked-files=no'], repo),
            'Reviewed tracked source changed')
    remote_tag(repo)
    require(checked(['npm', '--version']) == NPM, 'Use exact reviewed npm ' + NPM)


def inspect_archive(data):
    require(0 < len(data) <= MAX_ARCHIVE, 'Unexpected archive size')
    found = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        # Stream the header iteration; never extract paths to the filesystem.
        for member in archive:
            require(len(found) < len(ENTRIES), 'Too many archive entries')
            require(member.isfile() and member.name.startswith('package/'), 'Non-file archive entry')
            name = member.name.removeprefix('package/')
            require(name in ENTRIES and name not in found, 'Unexpected/duplicate archive entry: ' + name)
            size, expected = ENTRIES[name]
            require(member.size == size, 'Entry size mismatch: ' + name)
            content = archive.extractfile(member).read(size + 1)
            require(len(content) == size and digest(content) == expected, 'Entry hash mismatch: ' + name)
            found[name] = {'bytes': size, 'sha256': expected}
    require(set(found) == set(ENTRIES), 'Missing archive entries')
    sha512 = hashlib.sha512(data).digest()
    return {'sha1': digest(data, 'sha1'), 'sha256': digest(data),
            'sha512': sha512.hex(), 'integrity': 'sha512-' + base64.b64encode(sha512).decode(),
            'bytes': len(data), 'entries': found}


def candidate(repo, output, workflow_sha, run_id):
    source_fence(repo)
    require(re.fullmatch('[0-9a-f]{40}', workflow_sha), 'Invalid workflow commit')
    require(str(run_id).isdigit(), 'Invalid candidate run ID')
    output = Path(output)
    data = (output / TARBALL).read_bytes()
    payload = inspect_archive(data)
    require(payload['sha1'] == PRIOR_SHA1, 'Packed bytes differ from reviewed original runner')
    receipt = {'schema': 1, 'mode': 'candidate', 'source': SOURCE, 'tagObject': TAG_OBJECT,
               'package': PACKAGE, 'version': VERSION, 'distTag': 'latest',
               'workflowCommit': workflow_sha, 'workflowRef': 'refs/tags/' + TOOLING_TAG,
               'candidateRun': str(run_id), 'npm': NPM,
               'lockSHA256': digest((Path(repo) / 'package-lock.json').read_bytes()),
               'payload': payload}
    write_json(output / 'candidate.json', receipt, exclusive=True)
    return receipt


def validate_candidate(receipt, data, workflow_sha, run_id, sha256, sha512):
    payload = inspect_archive(data)
    require(re.fullmatch('[0-9a-f]{64}', sha256) and re.fullmatch('[0-9a-f]{128}', sha512),
            'Full candidate SHA256 and SHA512 are required')
    require(payload['sha256'] == sha256 and payload['sha512'] == sha512,
            'Artifact differs from explicitly reviewed full digests')
    require(payload['sha1'] == PRIOR_SHA1, 'Prior runner SHA1 mismatch')
    required = {'schema': 1, 'mode': 'candidate', 'source': SOURCE, 'tagObject': TAG_OBJECT,
                'package': PACKAGE, 'version': VERSION, 'distTag': 'latest',
                'workflowCommit': workflow_sha, 'workflowRef': 'refs/tags/' + TOOLING_TAG,
                'candidateRun': str(run_id), 'npm': NPM}
    require(all(receipt.get(k) == v for k, v in required.items()), 'Candidate receipt/source mismatch')
    require(receipt.get('payload') == payload, 'Candidate receipt payload mismatch')
    return payload


def download_candidate(output, workflow_sha, run_id, sha256, sha512):
    require(str(run_id).isdigit(), 'Invalid candidate run ID')
    run = github('actions/runs/' + str(run_id))
    require(run.get('head_sha') == workflow_sha and run.get('conclusion') == 'success'
            and run.get('status') == 'completed' and run.get('event') == 'workflow_dispatch'
            and run.get('path') == WORKFLOW and run.get('head_branch') == TOOLING_TAG,
            'Candidate run is not a successful reviewed tooling-tag workflow')
    artifacts = github('actions/runs/' + str(run_id) + '/artifacts?per_page=100')
    require(artifacts.get('total_count') == len(artifacts.get('artifacts', [])), 'Incomplete artifact list')
    matches = [a for a in artifacts['artifacts'] if a.get('name') == 'attachment-stage-candidate']
    require(len(matches) == 1 and not matches[0].get('expired'), 'Missing/ambiguous candidate artifact')
    artifact = matches[0]
    data = github('actions/artifacts/' + str(artifact['id']) + '/zip', binary=True)
    require(artifact.get('digest') == 'sha256:' + digest(data), 'GitHub artifact ZIP integrity mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(sorted(archive.namelist()) == sorted([TARBALL, 'candidate.json']), 'Unexpected ZIP entries')
        require(sum(e.file_size for e in archive.infolist()) <= MAX_ARCHIVE + 50_000,
                'Candidate ZIP expands too large')
        receipt = json.loads(archive.read('candidate.json'))
        payload = archive.read(TARBALL)
    validate_candidate(receipt, payload, workflow_sha, run_id, sha256, sha512)
    output = Path(output)
    (output / TARBALL).write_bytes(payload)
    write_json(output / 'candidate.json', receipt)
    write_json(output / 'candidate-artifact.json', artifact)
    return receipt


def registry_get(suffix=''):
    url = REGISTRY + urllib.parse.quote(PACKAGE, safe='') + suffix
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(2_000_001)
            require(len(data) <= 2_000_000, 'Registry response too large')
            return {'url': url, 'status': response.status, 'body': json.loads(data)}
    except urllib.error.HTTPError as error:
        # Only explicit404 is absence;401/403/timeouts/malformed200 are fatal.
        if error.code != 404:
            raise
        return {'url': url, 'status': 404}


def npm_read(args, output, label, cwd=None):
    result = command(['npm', 'stage', *args, '--json', '--registry=' + REGISTRY,
                      '--fetch-retries=0'], cwd)
    (Path(output) / (label + '.stdout')).write_text(result.stdout)
    (Path(output) / (label + '.stderr')).write_text(result.stderr)
    require(result.returncode == 0, f'npm stage {args[0]} failed (not absence): {result.stderr}')
    return json.loads(result.stdout)


def stage_list(output, label):
    items = npm_read(['list', PACKAGE], output, label)
    require(isinstance(items, list) and len(items) <= 100, 'Malformed/oversize stage list')
    for item in items:
        require(isinstance(item, dict) and item.get('packageName') == PACKAGE
                and isinstance(item.get('version'), str), 'Malformed/misfiltered stage item')
        stage_id(item.get('id'))
    return items


def stage_id(value):
    require(isinstance(value, str) and str(uuid.UUID(value)) == value, 'Invalid stage UUID')
    return value


def check_item(item, identity, sha1):
    require(isinstance(item, dict) and item.get('id') == identity
            and item.get('packageName') == PACKAGE and item.get('version') == VERSION
            and item.get('tag') == 'latest' and item.get('shasum') == sha1,
            'Stage identity/version/tag/shasum mismatch')


def ordinary_disposition(run, output):
    """Positive selection evidence, never infer non-execution from completion."""
    require(run.get('status') == 'completed', 'Another ordinary publication is unresolved')
    require(isinstance(run.get('head_sha'), str) and re.fullmatch('[0-9a-f]{40}', run['head_sha']),
            'Ordinary run source is malformed')
    run_id = run['id']
    artifacts = github('actions/runs/' + str(run_id) + '/artifacts?per_page=100')
    require(artifacts.get('total_count') == len(artifacts.get('artifacts', [])),
            'Incomplete ordinary release artifacts')
    receipts = [a for a in artifacts['artifacts']
                if isinstance(a.get('name'), str) and a['name'].startswith('release-receipt-')]
    require(len(receipts) == 1 and not receipts[0].get('expired'),
            'Ordinary attempt lacks an unambiguous retained release receipt')
    artifact = receipts[0]
    archive = github('actions/artifacts/' + str(artifact['id']) + '/zip', binary=True)
    require(artifact.get('digest') == 'sha256:' + digest(archive), 'Ordinary receipt ZIP integrity mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        require(zipped.namelist() == ['release-receipt.json']
                and zipped.infolist()[0].file_size <= 50_000, 'Malformed ordinary receipt archive')
        receipt = json.loads(zipped.read('release-receipt.json'))
    require(isinstance(receipt, dict) and receipt.get('sha') == run.get('head_sha')
            and isinstance(receipt.get('dryRun'), bool), 'Ordinary receipt is not source-bound')
    plugin = receipt.get('plugin')
    require(isinstance(plugin, str) and re.fullmatch('[a-z][a-z0-9-]*', plugin)
            and artifact['name'] == 'release-receipt-' + plugin
            and receipt.get('path') in ('packages/' + plugin, 'plugins/' + plugin)
            and receipt.get('workspace') == '@phosphorco/' + plugin,
            'Ordinary receipt selection is malformed')
    if plugin != 'bb-thread-attachments':
        disposition = 'verified-other-package'
    else:
        require(receipt['dryRun'] is True, 'A later attachment publication attempt needs explicit inspection')
        jobs = github('actions/runs/' + str(run_id) + '/jobs?per_page=100')
        require(jobs.get('total_count') == 1 and len(jobs.get('jobs', [])) == 1,
                'Incomplete dry-run jobs')
        job = jobs['jobs'][0]
        require(job.get('status') == 'completed', 'Unresolved dry-run job')
        writes = [s for s in job.get('steps', [])
                  if s.get('name', '').startswith(('Publish ', 'Bootstrap '))]
        require(any(s['name'] == 'Publish public package' for s in writes)
                and all(s.get('conclusion') == 'skipped' for s in writes),
                'Dry-run receipt lacks positive skipped-publication evidence')
        disposition = 'verified-dry-run-with-skipped-writes'
    evidence = {'run': run, 'artifact': artifact, 'receipt': receipt, 'disposition': disposition}
    if output is not None:
        write_json(Path(output) / ('ordinary-disposition-' + str(run_id) + '.json'), evidence)
    return evidence


def previous_attempt_fence(current_run, output=None):
    prior = github('actions/runs/' + str(PRIOR_RUN))
    require(prior.get('head_sha') == SOURCE and prior.get('conclusion') == 'failure'
            and prior.get('status') == 'completed' and prior.get('run_attempt') == 1,
            'Original failed publication was changed/retried')
    # A failed/completed/cancelled job can still have accepted a publication.
    # Inspect ALL ordinary attempts since the explicitly dispositioned original
    # EOTP run. Limit history to one complete100-row response; overflow stops.
    query = urllib.parse.urlencode({'per_page': 100, 'created': '>=' + PRIOR_CREATED})
    runs = github('actions/workflows/publish.yml/runs?' + query)
    require(isinstance(runs.get('workflow_runs'), list)
            and runs.get('total_count') == len(runs['workflow_runs'])
            and len(runs['workflow_runs']) <= 100, 'Incomplete ordinary publication history')
    require(sum(r.get('id') == PRIOR_RUN for r in runs['workflow_runs']) == 1,
            'Original failed publication missing from bounded history')
    if output is not None:
        write_json(Path(output) / 'ordinary-run-history.json', runs)
    for run in runs['workflow_runs']:
        require(isinstance(run.get('id'), int), 'Malformed ordinary run ID')
        if run['id'] == PRIOR_RUN:
            require(run.get('head_sha') == SOURCE and run.get('run_attempt') == 1
                    and run.get('status') == 'completed' and run.get('conclusion') == 'failure',
                    'Original failure changed within history')
        else:
            ordinary_disposition(run, output)
    runs = github('actions/workflows/stage-thread-attachments.yml/runs?per_page=100')
    require(runs.get('total_count') == len(runs.get('workflow_runs', [])), 'Incomplete stage run history')
    for run in runs['workflow_runs']:
        if str(run['id']) == str(current_run):
            continue
        require(run.get('status') == 'completed', 'Another stage workflow run is unresolved')
        jobs = github('actions/runs/' + str(run['id']) + '/jobs?per_page=100')
        require(jobs.get('total_count') == len(jobs.get('jobs', [])), 'Incomplete prior stage jobs')
        matching = [j for j in jobs['jobs'] if j.get('name') == 'Stage retained candidate']
        require(len(matching) == 1 and matching[0].get('conclusion') == 'skipped',
                'An earlier stage job already ran; inspect rather than retry')


def preflight(repo, output, receipt, current_run):
    source_fence(repo)
    require(digest((Path(repo) / 'package-lock.json').read_bytes()) == receipt['lockSHA256'],
            'Candidate lock receipt mismatch')
    previous_attempt_fence(current_run, output)
    registry = [registry_get(), registry_get('/' + VERSION)]
    write_json(Path(output) / 'registry-before.json', registry)
    require(all(r['status'] == 404 for r in registry),
            'Initial stage requires absent package/version; placeholder needs investigation')
    require(stage_list(output, 'stages-before') == [], 'Existing unresolved stage; do not submit')


def submit(output, payload):
    output = Path(output).resolve()
    # This intent precedes dispatch and persists even if stdout is lost.
    binding = {'packageSource': SOURCE, 'workflowCommit': os.environ.get('GITHUB_SHA'),
               'workflowRef': os.environ.get('GITHUB_REF'),
               'stageRun': os.environ.get('GITHUB_RUN_ID')}
    write_json(output / 'stage-intent.json', {**binding, 'package': PACKAGE,
               'version': VERSION, 'payload': payload, 'dispatches': 1}, exclusive=True)
    outcome = {**binding, 'state': 'unknown', 'dispatches': 1, 'approvalReady': False}
    try:
        result = command(['npm', 'stage', 'publish', str(output / TARBALL), '--json',
                          '--ignore-scripts', '--access=public', '--tag=latest', '--provenance',
                          '--registry=' + REGISTRY, '--fetch-retries=0'], output, timeout=180)
        (output / 'stage.stdout').write_text(result.stdout)
        (output / 'stage.stderr').write_text(result.stderr)
        outcome['exitCode'] = result.returncode
        require(result.returncode == 0, 'Stage command failed; inspect postflight; never replay')
        response = json.loads(result.stdout)
        require(isinstance(response, dict) and set(response) == {PACKAGE}, 'Unexpected npm stage JSON')
        info = response[PACKAGE]
        identity = stage_id(info.get('stageId'))
        outcome['stageId'] = identity
        require(info.get('name') == PACKAGE and info.get('version') == VERSION
                and info.get('shasum') == payload['sha1'], 'Stage response package mismatch')
        # A stage-list postflight happens in finally exactly once, on every
        # dispatched outcome, including process failure, timeout or bad JSON.
    except Exception as error:
        if isinstance(error, subprocess.TimeoutExpired):
            (output / 'stage.stdout').write_text(redact(error.output, os.environ))
            (output / 'stage.stderr').write_text(redact(error.stderr, os.environ))
        outcome['error'] = str(error)
    finally:
        for label, read in [('registryAfter', lambda: [registry_get(), registry_get('/' + VERSION)]),
                            ('stagesAfter', lambda: stage_list(output, 'stages-after'))]:
            try:
                outcome[label] = read()
            except Exception as error:
                outcome[label + 'Error'] = str(error)
        write_json(output / 'stage-outcome.json', outcome)
    require('error' not in outcome and 'registryAfterError' not in outcome
            and 'stagesAfterError' not in outcome, 'Unknown stage outcome; stop and inspect retained evidence')
    try:
        identity = outcome['stageId']
        require(len(outcome['stagesAfter']) == 1, 'Ambiguous stage list after submission')
        check_item(outcome['stagesAfter'][0], identity, payload['sha1'])
        require(outcome['registryAfter'][1]['status'] == 404, 'Version unexpectedly public; inspect')
        item = npm_read(['view', identity], output, 'stage-view')
        check_item(item, identity, payload['sha1'])
        download = output / 'download'; download.mkdir()
        npm_read(['download', identity], output, 'stage-download', download)
        filename = 'phosphorco-bb-thread-attachments-0.1.0-' + identity + '.tgz'
        require([p.name for p in download.iterdir()] == [filename], 'Unexpected stage download files')
        downloaded = (download / filename).read_bytes()
        require(inspect_archive(downloaded) == payload
                and downloaded == (output / TARBALL).read_bytes(), 'Downloaded stage differs from retained candidate')
        outcome.update(state='verified-awaiting-human-2fa', approvalReady=True,
                       downloadedPayload=inspect_archive(downloaded),
                       approvalLocation='https://www.npmjs.com/package/' + PACKAGE,
                       humanCommand='npm stage approve ' + identity,
                       publishedVersionVerified=False)
        write_json(output / 'stage-outcome.json', outcome)
        return outcome
    except Exception as error:
        outcome['error'] = str(error)
        write_json(output / 'stage-outcome.json', outcome)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['candidate', 'stage'])
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--workflow-sha', required=True)
    parser.add_argument('--candidate-run')
    parser.add_argument('--sha256')
    parser.add_argument('--sha512')
    args = parser.parse_args()
    require(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'Wrong repository')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Manual workflow only')
    require(os.environ.get('GITHUB_REF') == 'refs/tags/' + TOOLING_TAG,
            'Dispatch only from the independently reviewed immutable tooling tag')
    require(os.environ.get('GITHUB_SHA') == args.workflow_sha
            and re.fullmatch('[0-9a-f]{40}', args.workflow_sha), 'Workflow revision mismatch')
    output = Path(args.output).resolve(); output.mkdir(exist_ok=True)
    if args.mode == 'candidate':
        receipt = candidate(args.source, output, args.workflow_sha, os.environ['GITHUB_RUN_ID'])
        print(json.dumps(receipt, indent=2))
        return
    require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'Never rerun a stage job')
    require(os.environ.get('NODE_AUTH_TOKEN'), 'Existing npm management credential required; no OIDC fallback')
    receipt = download_candidate(output, args.workflow_sha, args.candidate_run, args.sha256, args.sha512)
    preflight(args.source, output, receipt, os.environ['GITHUB_RUN_ID'])
    result = submit(output, receipt['payload'])
    print(json.dumps(result, indent=2))
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as stream:
            stream.write('Verified stage `' + result['stageId'] + '` awaits human 2FA approval.\n\n'
                         + result['approvalLocation'] + '\n\nSHA256 `' + receipt['payload']['sha256']
                         + '`\n\nSHA512 `' + receipt['payload']['sha512'] + '`\n\n'
                         + 'Package source `' + SOURCE + '`; workflow source `' + args.workflow_sha + '`.\n\n'
                         + 'Placeholder availability is not publication of 0.1.0.\n')


if __name__ == '__main__':
    main()
