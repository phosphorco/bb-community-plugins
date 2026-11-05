import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, canonicalByteLength, JsonAdmissionError, LIMITS, resolveOutcomeBudget, splitDeferredIndices } from '../src/bounds.ts';

test('canonical JSON orders keys, preserves arrays, and does not call accessors/toJSON', () => {
  assert.equal(canonicalJson({ z: [3, { b: true, a: null }], a: 1 }), '{"a":1,"z":[3,{"a":null,"b":true}]}');
  const shared = { n: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"n":1},{"n":1}]');
  let reads = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => canonicalJson(getter), JsonAdmissionError);
  assert.equal(reads, 0);
  assert.throws(() => canonicalJson({ toJSON() { reads++; return 'bad'; } }), JsonAdmissionError);
  assert.equal(reads, 0);
});
test('byte admission includes variable-width UTF8, escaping and exact delimiters', () => {
  for (const value of ['é', '😀', '\n', '\\', { text: 'é😀\n\\' }]) {
    const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
    assert.equal(canonicalByteLength(value, bytes), bytes);
    assert.throws(() => canonicalJson(value, bytes - 1), error => error.code === 'over-budget');
  }
  assert.equal(canonicalByteLength('x'.repeat(65534)), 65536);
  assert.throws(() => canonicalJson('x'.repeat(65535)), error => error.code === 'over-budget');
});
test('cycles, holes, nonfinite/nonJSON objects and depth overflow fail explicitly', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, [1, , 2], NaN, Infinity, undefined, 1n, new Date(), new Map(), { x: undefined }]) {
    assert.throws(() => canonicalJson(value), error => error.code === 'invalid-json');
  }
  assert.throws(() => canonicalJson({ a: { b: 1 } }, 100, 1), error => error.code === 'over-depth');
});
test('every Resolve count has exact aggregate reserve and representable compact outcomes', () => {
  for (let n = 1; n <= 32; n++) {
    const budget = resolveOutcomeBudget(n);
    assert.ok(n * budget + LIMITS.resolveEnvelopeBytes <= LIMITS.responseBytes);
    assert.ok(budget >= LIMITS.compactOutcomeBytes);
  }
  assert.equal(resolveOutcomeBudget(1), 64512);
  assert.equal(resolveOutcomeBudget(8), 8064);
  assert.equal(resolveOutcomeBudget(32), 2016);
  for (const n of [0, 33, 1.5, NaN]) assert.throws(() => resolveOutcomeBudget(n));
});
test('odd/even/mixed deferred groups strictly shrink, keep original order and reach singleton', () => {
  for (let n = 2; n <= 32; n++) {
    for (let m = 1; m <= n; m++) {
      const indices = Array.from({ length: m }, (_, i) => i);
      const groups = splitDeferredIndices(indices, n);
      assert.deepEqual(groups.flat(), indices);
      for (const group of groups) assert.ok(group.length < n);
      if (groups.length === 2) assert.ok(groups[1].length - groups[0].length <= 1);
    }
  }
  assert.deepEqual(splitDeferredIndices([0, 2, 4], 8), [[0], [2, 4]]);
  for (const indices of [[1, 0], [0, 0], [3], [-1]]) assert.throws(() => splitDeferredIndices(indices, 3));
  assert.throws(() => splitDeferredIndices([0], 1), /Singleton/);
  assert.deepEqual(splitDeferredIndices([], 1), []);
});
