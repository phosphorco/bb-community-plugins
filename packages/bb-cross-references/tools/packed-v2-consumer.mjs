/** Run from an independently installed packed consumer; never installs/builds. */
import {spawnSync} from 'node:child_process';
import {realpathSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const location = process.argv[2];
if (!location) throw new Error('Pass consumer package.json path.');
const manifest = realpathSync(resolve(location));
if (!statSync(manifest).isFile()) throw new Error('Consumer manifest must be a file.');

// An eval module belongs to cwd: resolve AND import under native import conditions
// from the independent consumer, without an experimental resolve parent argument.
const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict';
import {lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

let installed = process.cwd();
for (const part of ['node_modules', '@phosphorco', 'bb-cross-references']) {
  installed = join(installed, part);
  const info = lstatSync(installed);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Packed consumer package root must not be symlinked.');
}
assert.equal(realpathSync(installed), installed, 'Packed consumer package root must be local.');
const specifiers = ['@phosphorco/bb-cross-references', '@phosphorco/bb-cross-references/bb', '@phosphorco/bb-cross-references/testing'];
const entries = specifiers.map(specifier => {
  const selected = fileURLToPath(import.meta.resolve(specifier));
  const physical = realpathSync(selected);
  const within = relative(installed, physical);
  assert.ok(within && within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within), 'Selected entry must belong to the consumer installed package.');
  assert.ok(lstatSync(physical).isFile(), 'Selected entry must be a regular file.');
  assert.ok(!physical.includes('/packages/bb-cross-references/'), 'Packed proof must not resolve a workspace symlink.');
  return selected;
});
const [root, bb, kit] = await Promise.all(specifiers.map(specifier => import(specifier)));
assert.equal(typeof root.listMentionsInputV2Schema.parse, 'function');
assert.equal(typeof root.githubLookup, 'function');
assert.equal(typeof bb.registerCrossReferencesV2, 'function');
assert.equal(typeof kit.runCrossReferencesV2Conformance, 'function');
console.log(JSON.stringify({level: 'packed-consumer-imports', root: entries[0], bb: entries[1], testing: entries[2]}));
`], {
  cwd: dirname(manifest),
  env: {...process.env, NODE_OPTIONS: '', NODE_PATH: ''},
  stdio: 'inherit',
  timeout: 10_000,
  killSignal: 'SIGKILL', // Only this child; an ignored TERM cannot extend the deadline.
});
if (result.error) throw result.error;
if (result.signal) throw new Error('Packed consumer child terminated by ' + result.signal);
process.exitCode = result.status ?? 1;
