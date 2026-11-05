import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
test('pack exposes emitted entries, declarations, documentation; vector has no seed',()=>{
  const result=spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stderr);
  const pack=JSON.parse(result.stdout)[0], files=new Set(pack.files.map(f=>f.path));
  for(const path of ['dist/index.js','dist/vector.js','dist/types/index.d.ts','dist/types/vector.d.ts','README.md','CONTRACT.md','LICENSE']) assert.ok(files.has(path),path);
  assert.equal([...files].some(f=>f.startsWith('src/')||f.startsWith('test/')),false);
  const vector=readFileSync('dist/vector.js','utf8'); assert.equal(/DEFAULT_RATE_TABLE|seed-2026|claude-sonnet/.test(vector),false);
  const root=readFileSync('dist/index.js','utf8'); assert.equal(/@get-bb|react|setInterval|setTimeout/.test(root),false);
});
