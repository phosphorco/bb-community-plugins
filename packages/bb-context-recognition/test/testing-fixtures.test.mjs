import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { arbitrate, canonicalJson, checkCandidate, negotiateVersion, nearestSpan } from '../dist/index.js';
import { versionFixtures, arbitrationFixtures, workedExamples } from '../dist/testing.js';

for (const [name, exported] of [['versions', versionFixtures], ['arbitration', arbitrationFixtures], ['worked-examples', workedExamples]]) {
  test(`raw ${name} JSON equals public testing fixture values`, () => {
    assert.deepEqual(exported, JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')));
  });
}
for (const vector of versionFixtures) test(`version fixture: ${vector.name}`, () => {
  assert.deepEqual(negotiateVersion(vector.envelope), vector.expected);
});
for (const vector of arbitrationFixtures) test(`arbitration fixture: ${vector.name}`, () => {
  // Canonical serialization ignores null-prototype result dictionaries.
  const expected = canonicalJson(vector.expected);
  assert.equal(canonicalJson(arbitrate(vector.tagged, vector)), expected);
  assert.equal(canonicalJson(arbitrate([...vector.tagged].reverse(), vector)), expected);
});
const tagged = (candidate, pluginId, specificity = 'typed', origin = 'contributed') => ({ candidate, pluginId, specificity, origin, providers: [candidate.source.provider] });
for (const fixture of workedExamples) test(`worked example: ${fixture.name}`, () => {
  const { input, output } = fixture;
  for (const c of output.candidates) assert.equal(checkCandidate(c, input).valid, true, `${fixture.name}: match and spans`);
  const tags = output.candidates.map(c => tagged(c, fixture.name === '11.4-thread-builtin' ? 'thread-brief' : 'supplier', 'typed', fixture.name === '11.4-thread-builtin' ? 'builtin' : 'contributed'));
  if (fixture.generic) tags.push(tagged(fixture.generic, 'generic', 'generic', fixture.generic.source.provider.startsWith('bb.') ? 'builtin' : 'contributed'));
  if (fixture.contributedCopyDropped) tags.push(tagged(output.candidates[0], 'reserved-supplier'));
  const result = arbitrate(tags, input);
  assert.equal(result.occurrences.length, output.candidates.length);
  if (fixture.expectedPrimaryProvider) assert.equal(result.occurrences[0].candidate.source.provider, fixture.expectedPrimaryProvider);
  if (fixture.expectedFallbackProvider) assert.equal(result.occurrences[0].fallback.candidate.source.provider, fixture.expectedFallbackProvider);
  if (fixture.contributedCopyDropped) assert.equal(result.dropped['reserved-supplier'], 1);
  if (fixture.excludedInput) {
    const excluded = fixture.excludedInput;
    const c = { ...output.candidates[0], span: { start: 9, end: 9 + input.text.length }, match: input.text };
    assert.equal(checkCandidate(c, excluded).valid, false);
    assert.equal(excluded.context.links[0].href, input.text);
  }
});
test('Text A uses checked UTF-16 offsets 8..57 and 68..72', () => {
  const a = workedExamples.find(f => f.name === '11.1-text-a');
  assert.deepEqual(a.output.candidates.map(c => c.span), [{ start: 8, end: 57 }, { start: 68, end: 72 }]);
  assert.equal(a.input.text.slice(68, 72), '#312');
});
test('nearest link distance is between intervals, with preceding tie preference', () => {
  const preceding = { start: 0, end: 4, repo: 'before' }, following = { start: 10, end: 14, repo: 'after' };
  assert.equal(nearestSpan({ start: 6, end: 8 }, [following, preceding]), preceding);
});
