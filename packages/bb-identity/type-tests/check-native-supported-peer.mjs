/** Explicit actual-peer artifact job: no installs or declaration copies.
 * node check-native-supported-peer.mjs <archive.tgz> <existing-peer-consumer-root> */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [archive, peerRoot] = process.argv.slice(2).map(value => resolve(value));
assert.ok(archive && peerRoot, 'Pass exact archive and existing actual peer consumer root.');
const modules = join(peerRoot, 'node_modules');
const sdk = JSON.parse(await readFile(join(modules, '@get-bb/plugin-sdk/package.json'), 'utf8'));
assert.equal(sdk.version, '0.6.31', 'This conformance witness identifies the actual public supported peer 0.6.31.');
const scratch = await mkdtemp(join(tmpdir(), 'bb-identity-public-peer-'));
try {
  const scope = join(scratch, 'node_modules', '@phosphorco');
  await mkdir(scope, { recursive: true });
  const unpack = spawnSync('tar', ['-xzf', archive, '-C', scope], { encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  await rename(join(scope, 'package'), join(scope, 'bb-identity'));
  for (const entry of await readdir(modules)) {
    if (entry.startsWith('.') || entry === '@phosphorco') continue;
    await symlink(join(modules, entry), join(scratch, 'node_modules', entry));
  }
  await writeFile(join(scratch, 'package.json'), '{"private":true,"type":"module"}\n');
  const manifest = JSON.parse(await readFile(join(scope, 'bb-identity', 'package.json'), 'utf8'));
  const imports = Object.keys(manifest.exports).map((key, i) => `import * as e${i} from ${JSON.stringify(manifest.name + (key === '.' ? '' : key.slice(1)))}; void e${i};`).join('\n');
  await writeFile(join(scratch, 'all-entry.ts'), imports);
  const witness = await readFile(fileURLToPath(new URL('./native-supported-peer.test-d.ts', import.meta.url)), 'utf8');
  await writeFile(join(scratch, 'native-peer.ts'), witness + `\nimport type { NativeActor, NativeMention } from '@phosphorco/bb-identity/native';\ntype AssertNever<T extends never> = T;\ntype AbsentAuthors = AssertNever<NativeActor>;\ntype AbsentMentions = AssertNever<NativeMention>;\n`);
  const checked = spawnSync(join(modules, '.bin', 'tsc'), ['--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2023', 'all-entry.ts', 'native-peer.ts'], { cwd: scratch, encoding: 'utf8' });
  process.stdout.write(checked.stdout ?? ''); process.stderr.write(checked.stderr ?? '');
  assert.equal(checked.status, 0, 'Strict actual supported-peer public declarations and calls must pass without skipLibCheck.');
  process.stdout.write(`public SDK ${sdk.version}: all ${Object.keys(manifest.exports).length} entries and minimal native calls pass; absent attribution remains unmanufactured.\n`);
} finally { await rm(scratch, { recursive: true, force: true }); }
