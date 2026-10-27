"""CI helper for explicitly approved pinned bb-identity next payloads."""
import base64
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import tarfile
import zipfile

REPOSITORY = 'phosphorco/bb-community-plugins'
WORKFLOW = '.github/workflows/publish.yml'
HELPER = '.github/scripts/bb-identity-next-release.py'
PACKAGE = 'packages/bb-identity'
NAME = '@phosphorco/bb-identity'
APPROVED_VERSIONS = frozenset({'0.4.0', '0.4.1'})
RECEIPT = 'package-receipt.json'
LIMIT = 16 * 1024 * 1024
OUT = Path('release-candidate')

def require(condition, message):
    if not condition:
        raise ValueError(message)

def command(*args):
    return subprocess.check_output(args).decode().strip()

def selected_version():
    version = os.environ['EXPECTED_VERSION']
    require(version in APPROVED_VERSIONS, 'Unapproved pinned bb-identity version')
    return version

def tgz_name(version):
    require(version in APPROVED_VERSIONS, 'Unapproved pinned bb-identity version')
    return f'phosphorco-bb-identity-{version}.tgz'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def bounded_file(path):
    require(path.is_file() and not path.is_symlink(), 'Expected a regular payload file')
    require(path.stat().st_size <= LIMIT, 'Oversized payload file')
    return path.read_bytes()

def expected():
    sha = os.environ['EXPECTED_SHA']
    require(re.fullmatch('[0-9a-f]{40}', sha), 'Invalid expected source SHA')
    version = selected_version()
    require(os.environ['GITHUB_REPOSITORY'] == REPOSITORY, 'Wrong repository')
    require(os.environ['GITHUB_SHA'] == sha == command('git', 'rev-parse', 'HEAD'), 'Checked-out source drift')
    require(json.loads(Path(PACKAGE, 'package.json').read_text())['version'] == version, 'Package version drift')
    return sha, version

def sources():
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--', PACKAGE, 'package.json', 'package-lock.json', WORKFLOW, HELPER]).decode().split('\0')
    paths = sorted(p for p in paths if p)
    require(paths and len(paths) <= 2000 and WORKFLOW in paths and HELPER in paths, 'Missing or oversized tracked release source')
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', *paths], check=True, stdout=subprocess.DEVNULL)
    result = {}
    total = 0
    for path in paths:
        data = bounded_file(Path(path))
        total += len(data)
        require(total <= LIMIT, 'Oversized tracked source content')
        result[path] = digest(data)
    return result

def bounded_tar_stream(data):
    # Bound the WHOLE gzip output before parsing TAR, including directory and
    # extension headers, file padding, end blocks and trailing compressed members.
    with gzip.GzipFile(fileobj=io.BytesIO(data), mode='rb') as compressed:
        stream = compressed.read(LIMIT + 1)
    require(len(stream) <= LIMIT, 'Oversized complete decompressed TAR stream')
    offset = 0
    headers = 0
    while offset < len(stream):
        require(offset + tarfile.BLOCKSIZE <= len(stream), 'Truncated TAR header')
        header = stream[offset:offset + tarfile.BLOCKSIZE]
        if header == bytes(tarfile.BLOCKSIZE):
            require(not any(stream[offset:]), 'Nonzero data after TAR end marker')
            break
        headers += 1
        require(headers <= 256, 'Too many physical TAR headers')
        member = tarfile.TarInfo.frombuf(header, 'utf-8', 'surrogateescape')
        require(member.size >= 0, 'Negative TAR size')
        offset += tarfile.BLOCKSIZE + ((member.size + 511) // 512) * 512
        require(offset <= len(stream), 'Truncated TAR member data')
    return stream

def payload(path, version):
    data = bounded_file(path)
    files = {}
    total = 0
    stream = bounded_tar_stream(data)
    with tarfile.open(fileobj=io.BytesIO(stream), mode='r:') as archive:
        for index, member in enumerate(archive, 1):
            require(index <= 256, 'Too many logical TAR members')
            require(member.name.startswith('package/') and '..' not in Path(member.name).parts and not Path(member.name).is_absolute(), 'Invalid archive path')
            require(member.isfile() or member.isdir(), 'Non-data archive member')
            if member.isdir():
                continue
            require(member.name not in files and 0 <= member.size <= LIMIT, 'Duplicate/oversized archive member')
            total += member.size
            require(total <= LIMIT and len(files) < 256, 'Oversized archive content')
            content = archive.extractfile(member).read()
            files[member.name] = {'bytes': len(content), 'sha256': digest(content), 'mode': member.mode}
            if member.name == 'package/package.json':
                manifest = json.loads(content)
    require('package/package.json' in files, 'Missing package manifest')
    require(manifest['name'] == NAME and manifest['version'] == version, 'Wrong package payload')
    require(manifest == json.loads(Path(PACKAGE, 'package.json').read_text()), 'Payload manifest differs from checked-out source')
    for target in manifest['exports'].values():
        for entry in target.values():
            require(isinstance(entry, str) and entry.startswith('./') and 'package/' + entry[2:] in files, 'Missing public export target')
    return {'archive': tgz_name(version), 'bytes': len(data), 'sha256': digest(data), 'shasum': hashlib.sha1(data).hexdigest(), 'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode(), 'exports': manifest['exports'], 'files': dict(sorted(files.items()))}

def capture():
    sha, version = expected()
    tgz = tgz_name(version)
    pack = json.loads(Path(OUT, 'pack.json').read_text())
    require(len(pack) == 1 and pack[0]['filename'] == tgz, 'Expected exactly one selected release archive')
    result = payload(OUT / tgz, version)
    require(pack[0]['shasum'] == result['shasum'] and pack[0]['integrity'] == result['integrity'], 'npm pack integrity mismatch')
    receipt = {'schema': 1, 'repository': REPOSITORY, 'workflow': WORKFLOW, 'sourceCommit': sha, 'sourceTree': command('git', 'rev-parse', 'HEAD^{tree}'), 'packageTree': command('git', 'rev-parse', 'HEAD:' + PACKAGE), 'sourceFiles': sources(), 'package': NAME, 'version': version, 'distTag': 'next', 'dryRun': True, 'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'payload': result}
    (OUT / RECEIPT).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'payloadSHA256': result['sha256'], 'receiptSHA256': digest((OUT / RECEIPT).read_bytes()), 'integrity': result['integrity']}))

def api(path, binary=False):
    # Fixed repository/endpoints only; do not execute artifact-controlled URLs.
    with subprocess.Popen(['gh', 'api', path], stdout=subprocess.PIPE) as process:
        data = process.stdout.read(LIMIT + 1)
        if len(data) > LIMIT:
            process.kill()
            process.wait()
            raise ValueError('Oversized GitHub API response')
        require(process.wait() == 0, 'GitHub artifact read failed')
    return data if binary else json.loads(data)

def download():
    sha, version = expected()
    run_id = os.environ['PROOF_RUN_ID']
    require(re.fullmatch('[1-9][0-9]{0,19}', run_id), 'Invalid proof run ID')
    run = api(f'repos/{REPOSITORY}/actions/runs/{run_id}')
    require(str(run['id']) == run_id and run['repository']['full_name'] == REPOSITORY and run['head_repository']['full_name'] == REPOSITORY, 'Wrong proof repository/run')
    require(run['path'] == WORKFLOW and run['head_sha'] == sha and run['event'] == 'workflow_dispatch' and run['status'] == 'completed' and run['conclusion'] == 'success', 'Proof run is not successful same-source manual workflow')
    listing = api(f'repos/{REPOSITORY}/actions/runs/{run_id}/artifacts?per_page=100')
    require(listing['total_count'] <= 100, 'Unbounded artifact listing')
    name = f'bb-identity-next-{sha}-{run_id}'
    found = [a for a in listing['artifacts'] if a['name'] == name and not a['expired']]
    require(len(found) == 1, 'Expected one retained proof artifact')
    artifact = found[0]
    require(type(artifact['id']) is int and artifact['id'] > 0 and artifact['size_in_bytes'] <= LIMIT, 'Invalid/oversized artifact')
    require(artifact['workflow_run']['id'] == int(run_id) and artifact['workflow_run']['head_sha'] == sha, 'Artifact source/run mismatch')
    archive = api(f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip", binary=True)
    OUT.mkdir()
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        members = zipped.infolist()
        tgz = tgz_name(version)
        require(len(members) == 2 and {m.filename for m in members} == {tgz, RECEIPT}, 'Unexpected artifact files')
        require(sum(m.file_size for m in members) <= LIMIT, 'Oversized extracted artifact')
        for member in members:
            require(not stat.S_ISLNK(member.external_attr >> 16), 'Artifact link refused')
            (OUT / member.filename).write_bytes(zipped.read(member))
    (Path('artifact-selection.json')).write_text(json.dumps({'runId': run_id, 'artifactId': artifact['id'], 'name': name, 'sourceCommit': sha}, sort_keys=True) + '\n')
    verify()

def verify():
    sha, version = expected()
    tgz = tgz_name(version)
    for key, path in [('EXPECTED_PAYLOAD_SHA256', OUT / tgz), ('EXPECTED_RECEIPT_SHA256', OUT / RECEIPT)]:
        require(re.fullmatch('[0-9a-f]{64}', os.environ[key]), 'Invalid reviewed hash')
        require(digest(bounded_file(path)) == os.environ[key], 'Reviewed payload/receipt hash mismatch')
    receipt = json.loads((OUT / RECEIPT).read_text())
    require(receipt['schema'] == 1 and receipt['repository'] == REPOSITORY and receipt['workflow'] == WORKFLOW and receipt['sourceCommit'] == sha, 'Receipt source mismatch')
    require(receipt['package'] == NAME and receipt['version'] == version and receipt['distTag'] == 'next' and receipt['dryRun'] is True and receipt['runId'] == os.environ['PROOF_RUN_ID'], 'Receipt is not selected dryrun payload')
    require(receipt['sourceTree'] == command('git', 'rev-parse', 'HEAD^{tree}') and receipt['packageTree'] == command('git', 'rev-parse', 'HEAD:' + PACKAGE) and receipt['sourceFiles'] == sources(), 'Receipt source content drift')
    require(receipt['payload'] == payload(OUT / tgz, version), 'Receipt files/exports/archive integrity mismatch')
    print('Verified exact reviewed dryrun archive; no build, pack, or publish performed by helper.')

def registry_read(selector, field):
    with subprocess.Popen(['npm', 'view', selector, field, '--json', '--registry', 'https://registry.npmjs.org/'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        data = process.stdout.read(LIMIT + 1)
        if len(data) > LIMIT:
            process.kill()
            process.wait()
            raise ValueError('Oversized registry response')
        status = process.wait()
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise ValueError('Registry read did not provide bounded JSON; do not infer absence')
    return status, value

def preflight():
    _, version = expected()
    verify()
    approved_text = os.environ['EXPECTED_PREFLIGHT_TAGS']
    require(len(approved_text) <= 4096, 'Oversized approved preflight tags')
    approved = json.loads(approved_text)
    require(type(approved) is dict and 'latest' in approved and len(approved) <= 100 and all(isinstance(k, str) and 0 < len(k) <= 128 and isinstance(v, str) and 0 < len(v) <= 128 for k, v in approved.items()), 'Invalid owner-approved preflight tags')
    code, tags = registry_read(NAME, 'dist-tags')
    require(code == 0 and tags == approved, 'Registry dist-tags drift from owner-approved payload; stop before publication')
    code, registry_version = registry_read(NAME + '@' + version, 'version')
    require(code != 0 and isinstance(registry_version, dict) and registry_version.get('error', {}).get('code') == 'E404', 'Version exists or registry result is unresolved; stop for owner inspection, never republish')
    Path('registry-before.json').write_text(json.dumps({'tags': tags, 'versionAbsent': version}, sort_keys=True) + '\n')

def postflight():
    _, version = expected()
    verify()
    before = json.loads(Path('registry-before.json').read_text())
    def observe(selector, field):
        try:
            status, value = registry_read(selector, field)
            return {'exitCode': status, 'value': value}
        except Exception as error:
            return {'unresolved': type(error).__name__}
    # Observe both exactly once and persist actual outcomes before assessing them.
    # Nonzero publish may still have committed remotely; never infer absence.
    tags = observe(NAME, 'dist-tags')
    dist = observe(NAME + '@' + version, 'dist')
    after = {'approvedPreflightTags': before['tags'], 'tagsRead': tags, 'distRead': dist}
    Path('registry-after.json').write_text(json.dumps(after, sort_keys=True) + '\n')
    expected_tags = {**before['tags'], 'next': version}
    require(tags.get('exitCode') == 0 and tags.get('value') == expected_tags, 'Registry tags do not match approved next-only effect; inspect without retry or rollback')
    receipt = json.loads((OUT / RECEIPT).read_text())
    require(dist.get('exitCode') == 0 and isinstance(dist.get('value'), dict) and dist['value'].get('integrity') == receipt['payload']['integrity'] and dist['value'].get('shasum') == receipt['payload']['shasum'], 'Published integrity differs or is unresolved; inspect without retry')

def publish():
    _, version = expected()
    archive = (OUT / tgz_name(version)).resolve(strict=True)
    require(digest(bounded_file(archive)) == os.environ['EXPECTED_PAYLOAD_SHA256'], 'Reviewed publish payload drift')
    require(not any(os.path.lexists(p) for p in ('.npmrc', PACKAGE + '/.npmrc')), 'Unexpected project npmrc; refuse publish')
    require(json.loads(Path(PACKAGE, 'package.json').read_text()).get('publishConfig') == {'access': 'public'}, 'Unexpected publishConfig')
    with tempfile.TemporaryDirectory(prefix='bb-identity-oidc-publish-') as isolated:
        user = Path(isolated, 'user.npmrc')
        global_config = Path(isolated, 'global.npmrc')
        user.write_text('')
        global_config.write_text('')
        # No inherited npm settings, credentials or direct token overrides.
        # Current GitHub OIDC request and CI/provenance context remain intact.
        blocked = {'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN', 'NPM_ID_TOKEN', 'SIGSTORE_ID_TOKEN', 'NPM_USERNAME', 'NPM_PASSWORD'}
        env = {k: v for k, v in os.environ.items() if not k.lower().startswith('npm_config_') and k.upper() not in blocked}
        env.update(NODE_AUTH_TOKEN='', NPM_TOKEN='', NPM_ID_TOKEN='')
        result = subprocess.run([
            'npm', 'publish', str(archive), '--registry', 'https://registry.npmjs.org/',
            '--access', 'public', '--tag', 'next', '--ignore-scripts', '--provenance', '--json',
            '--userconfig', str(user), '--globalconfig', str(global_config),
            '--prefix', isolated, '--cache', str(Path(isolated, 'cache')),
        ], cwd=isolated, env=env)
    raise SystemExit(result.returncode if result.returncode >= 0 else 128 - result.returncode)

if __name__ == '__main__':
    require(len(sys.argv) == 2 and sys.argv[1] in ('capture', 'download', 'verify', 'preflight', 'postflight', 'publish'), 'Expected capture/download/verify/preflight/postflight/publish')
    globals()[sys.argv[1]]()
