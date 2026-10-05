import test from 'node:test';
import assert from 'node:assert/strict';
import { applicable } from '../../dist/testing.js';

const list = [{ id: 'a', run: async () => {} }, { id: 'b', run: async () => {} }, { id: 'c', skip: 'gap', run: async () => {} }];

test('notApplicable omits the declared scenario instead of skipping it', () => {
  assert.deepEqual(applicable(list, { notApplicable: { b: 'role has no protected fields' } }).map((s) => s.id), ['a', 'c']);
});
test('notApplicable requires a reason, a known id, and no overlap with skip', () => {
  assert.throws(() => applicable(list, { notApplicable: { b: ' ' } }), /needs a reason/);
  assert.throws(() => applicable(list, { notApplicable: { zz: 'x' } }), /unknown scenario/);
  assert.throws(() => applicable(list, { notApplicable: { a: 'x' }, skip: { a: 'y' } }), /both skipped and notApplicable/);
  assert.throws(() => applicable(list, { skip: { a: '' } }), /skip 'a' needs a reason/);
});
