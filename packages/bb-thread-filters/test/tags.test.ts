import { expect, test } from 'bun:test';
import { addTag, hasTag, normalizeTag, readTags, removeTag, setTags, toggleTag } from '../src/tags.js';

test('title is the source of truth; toggles retain insertion order', () => {
  const title = 'Fix #one #two';
  expect(addTag(title, '#ONE')).toBe(title);
  expect(removeTag(title, 'absent')).toBe(title);
  expect(hasTag(title, 'ONE')).toBe(true);
  const removed = toggleTag(title, 'one');
  expect(removed).toBe('Fix #two');
  expect(toggleTag(removed, 'one')).toBe('Fix #two #one');
  expect(toggleTag(title, 'one', true)).toBe(title);
  expect(toggleTag(title, 'absent', false)).toBe(title);
  expect(setTags(title, ['two', 'one'])).toBe('Fix #two #one');
});

test('tag edits preserve URLs, groups, colons, punctuation and unrelated whitespace', () => {
  const title = 'Investigate  https://example.com/a:b  #Bug #two';
  expect(setTags(title, ['bug', 'two'])).toBe(title);
  expect(setTags(title, ['two', 'review'])).toBe('Investigate  https://example.com/a:b  #two #review');
  expect(setTags('infra/api: Fix: parser #old', ['new'])).toBe('infra/api: Fix: parser #new');
  expect(readTags('#urgent Fix: subject #bug')).toEqual(['urgent', 'bug']);
  expect(removeTag('#one Subject #two', 'one')).toBe('Subject #two');
  expect(removeTag('Subject #one', 'one')).toBe('Subject');
  expect(removeTag('#one', 'one')).toBe('');
});

test('recognition and validation agree on whole tokens, Unicode, and limits', () => {
  expect(readTags('Fix #foo.bar #c++ #123 #good-tag #e\u0301tat #ÉTAT')).toEqual(['good-tag', 'état']);
  expect(normalizeTag('#e\u0301tat')).toBe('état');
  expect(normalizeTag('#foo.bar')).toBe(null);
  expect(normalizeTag('##one')).toBe(null);
  expect(readTags('abc#one ##two #three')).toEqual(['three']);
  expect(readTags('https://example.com/#anchor C# #123')).toEqual([]);
  expect(normalizeTag('a'.repeat(65))).toBe(null);
  expect(addTag('Subject', 'foo.bar')).toBe('Subject');
});

test('setTags deduplicates ordered input and retains surviving tag positions', () => {
  expect(setTags('Subject #One detail #two', ['one', 'two', 'ONE'])).toBe('Subject #One detail #two');
  expect(setTags('Subject #One detail #two', ['one', 'three'])).toBe('Subject #One detail #three');
  expect(setTags('Subject #one #two', [])).toBe('Subject');
  expect(removeTag('Subject #ONE #one #two', 'one')).toBe('Subject #two');
});

test('tabs, newlines, overlong and invalid tokens survive unless adjacent to a removed tag', () => {
  const literal = '#'+ 'x'.repeat(65);
  expect(setTags(`Subject\twith\nspaces #old ${literal} #foo.bar`, ['new'])).toBe(`Subject\twith\nspaces ${literal} #foo.bar #new`);
  expect(setTags('Title\t#one\n#two', ['two', 'one'])).toBe('Title\t#two #one');
  expect(setTags('Subject #one #two #three', ['three', 'one', 'two'])).toBe('Subject #three #one #two');
  for (const wanted of [[], ['one'], ['two', 'one'], ['two', 'new', 'one'], ['new', 'three']]) {
    const title = setTags('Subject #one detail #two', wanted);
    expect(readTags(title)).toEqual(wanted);
    expect(setTags(title, wanted)).toBe(title);
  }
});
