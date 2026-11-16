import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { utf8ByteLength } from '../utf8-byte-length.ts';
import { createNativeSourceAdapter, NATIVE_SOURCE_LIMITS as LIMITS } from '@phosphorco/bb-identity/native';
import * as f from './native-review-fixtures.mjs';

const encoder = new TextEncoder();
const sameLength = text => assert.equal(utf8ByteLength(text), encoder.encode(text).byteLength);

test('UTF-8 counting matches TextEncoder for every UTF-16 code unit, including lone surrogates', () => {
  sameLength('');
  for (let unit = 0; unit < 0x10000; unit++) sameLength(String.fromCharCode(unit));
});

test('UTF-8 counting preserves paired and unpaired surrogate combinations and JSON escape expansion', () => {
  const high = String.fromCharCode(0xd800), low = String.fromCharCode(0xdc00);
  for (const text of ['ASCII', '日本語', '😃', String.fromCharCode(0), String.fromCharCode(10, 34, 92),
    high, low, high + low, String.fromCharCode(0xdbff, 0xdfff), high + 'X' + low, high + high + low, low + high + low]) {
    sameLength(text); sameLength(JSON.stringify(text));
  }
  let seed = 731;
  for (let sample = 0; sample < 4000; sample++) {
    let text = '';
    for (let unit = 0; unit < 40; unit++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += String.fromCharCode(seed >>> 16);
    }
    sameLength(text); sameLength(JSON.stringify(text));
  }
});

test('native evidence preserves Unicode text while whole-input and serialized limits remain enforced', () => {
  const adapter = createNativeSourceAdapter();
  for (const text of ['Visible 日本語 😃', 'Visible ' + String.fromCharCode(0xd800), 'Visible ' + String.fromCharCode(0xdc00)]) {
    const snapshot = f.base(); snapshot.timeline.rows[0].text = text;
    const result = adapter.resolve(snapshot);
    assert.equal(result.ok, true); assert.equal(result.value.text[0].text, text);
  }
  const unrelated = f.base();
  unrelated.timeline.rows.push({ ...f.row(), id: 'unrelated', turnId: 'other', text: 'x'.repeat(LIMITS.bytes + 1) });
  assert.equal(adapter.resolve(unrelated).ok, false, 'unrelated oversized input is still validated');
  const escaped = f.base(); escaped.timeline.rows[0].text = String.fromCharCode(0).repeat(360000);
  assert.equal(adapter.resolve(escaped).ok, false, 'JSON escape expansion remains bounded');
  let invoked = 0; const accessor = f.base();
  Object.defineProperty(accessor.timeline.rows[0], 'text', { get() { invoked++; return 'Visible'; }, enumerable: true });
  assert.equal(adapter.resolve(accessor).ok, false); assert.equal(invoked, 0);
});
