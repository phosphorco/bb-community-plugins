import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packResults, paneColumns, initialResultLimit, INLINE_RESULT_CEILING } from '../gallery/packing.ts';

function validGeometry(items: { key: string; width: number; height: number }[], columns: number) {
  const result = packResults(items, columns), cells = new Set<string>();
  assert.equal(result.columns, columns); assert.ok(result.rows <= INLINE_RESULT_CEILING * 4);
  assert.deepEqual(result.placements.map(item => item.key), items.map(item => item.key));
  for (const [index, p] of result.placements.entries()) {
    assert.equal(p.order, index); assert.ok(p.column >= 0 && p.column + p.width <= columns);
    assert.equal(p.width, Math.min(items[index]!.width, columns)); assert.equal(p.height, items[index]!.height);
    for (let y = p.row; y < p.row + p.height; y++) for (let x = p.column; x < p.column + p.width; x++) {
      const key = `${x}/${y}`; assert.equal(cells.has(key), false, `Overlapping result at ${key}`); cells.add(key);
    }
  }
  return result;
}
test('local width chooses bounded responsive columns and proportional initial prefix', () => {
  for (const width of [0, 70, 152, 230]) assert.equal(paneColumns(width), 1);
  assert.equal(paneColumns(316), 2); assert.equal(paneColumns(480), 3); assert.equal(paneColumns(644), 4);
  assert.equal(paneColumns(4000), 4);
  assert.deepEqual([1, 2, 3, 4].map(initialResultLimit), [2, 4, 8, 8]);
  for (const width of [-1, NaN, Infinity]) assert.throws(() => paneColumns(width));
});
test('accepted eight-item varied span case packs without overlap in every pane and preserves DOM/tab identity order', () => {
  const items = [[2, 2], [1, 1], [1, 2], [2, 1], [1, 1], [2, 2], [4, 2], [1, 1]].map(([width, height], index) => ({ key: `result:${index}`, width: width!, height: height! }));
  for (const columns of [1, 2, 3, 4]) {
    const packed = validGeometry(items, columns);
    assert.deepEqual(packResults(items, columns), packed);
    assert.deepEqual(items.map(item => item.key), packed.placements.map(item => item.key));
  }
});
test('all 1..4 span combinations at the inline ceiling stay within the bounded local rectangle', () => {
  for (let phase = 0; phase < 16; phase++) {
    const items = Array.from({ length: INLINE_RESULT_CEILING }, (_, index) => ({ key: `identity:${index}`,
      width: (index + phase) % 4 + 1, height: Math.floor((index + phase) / 4) % 4 + 1 }));
    for (const columns of [1, 2, 3, 4]) validGeometry(items, columns);
  }
});
test('content resolution does not change geometry; removing a result does not rename retained focus keys', () => {
  const items = [{ key: 'image:event1', width: 2, height: 2 }, { key: 'pr:event2', width: 1, height: 1 }, { key: 'plan:event3', width: 4, height: 2 }];
  const before = packResults(items, 4);
  const resolved = items.map(item => ({ ...item, loaded: true, naturalHeight: 4000 }));
  assert.deepEqual(packResults(resolved, 4), before);
  const resized = packResults(resolved, 1);
  assert.deepEqual(resized.placements.map(item => item.key), before.placements.map(item => item.key));
  assert.deepEqual(packResults(items.slice(1), 4).placements.map(item => item.key), ['pr:event2', 'plan:event3']);
});
test('empty geometry and explicit capacity/identity/span admission never silently drop cards', () => {
  assert.deepEqual(packResults([], 2), { columns: 2, rows: 0, placements: [] });
  assert.throws(() => packResults(Array.from({ length: 65 }, (_, i) => ({ key: `${i}`, width: 1, height: 1 })), 4));
  for (const item of [{ key: '', width: 1, height: 1 }, { key: 'é'.repeat(513), width: 1, height: 1 },
    { key: 'a', width: 0, height: 1 }, { key: 'a', width: 1, height: 5 }, { key: 'a', width: 1.1, height: 1 }]) assert.throws(() => packResults([item], 4));
  assert.throws(() => packResults([{ key: 'same', width: 1, height: 1 }, { key: 'same', width: 2, height: 2 }], 4));
});
