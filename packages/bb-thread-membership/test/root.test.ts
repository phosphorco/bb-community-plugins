import { describe, expect, test } from 'bun:test';
import { LIMITS, METHODS, PROTOCOL, PageInputV1Schema, PageOutputV1Schema, ScopeSchema, canonicalJson, canonicalJsonWithin, plainJsonSnapshot, negotiateVersion, pageViolation } from '../src/index.ts';

describe('negotiation', () => {
  test.each([
    [{ protocol: PROTOCOL, versions: [1] }, { version: 1 }],
    [{ protocol: PROTOCOL, versions: [1, 2] }, { version: 1 }],
    [{ protocol: PROTOCOL, versions: [2] }, null],
    [{ protocol: PROTOCOL, versions: [] }, null],
    [{ protocol: 'other', versions: [1] }, null],
    ['malformed', null],
    [{ protocol: PROTOCOL, versions: [1], futureField: { nested: true } }, { version: 1 }],
  ] as [unknown, unknown][])('%j → %j', (describe, expected) => expect(negotiateVersion(describe) as unknown).toEqual(expected));
});

describe('input is strict and bounded', () => {
  const ok = { scope: { mapId: 'm', topicKey: 't' }, cursor: null, limit: 20 };
  test('accepts a plain request', () => expect(PageInputV1Schema.safeParse(ok).success).toBe(true));
  test.each([
    ['unknown field', { ...ok, extra: 1 }],
    ['limit 0', { ...ok, limit: 0 }],
    ['limit above page', { ...ok, limit: LIMITS.pageMembers + 1 }],
    ['oversized scope', { ...ok, scope: { big: 'x'.repeat(LIMITS.scopeBytes) } }],
    ['deep scope', { ...ok, scope: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }],
    ['non-JSON scope', { ...ok, scope: new Date() }],
    ['control characters in cursor', { ...ok, cursor: 'a\u0000b' }],
  ])('rejects %s', (_name, input) => expect(PageInputV1Schema.safeParse(input).success).toBe(false));
  test('scope keeps opaque JSON', () => expect(ScopeSchema.parse({ z: 1, a: [true, null] })).toEqual({ z: 1, a: [true, null] }));
});

describe('output tolerates additions and closes failures', () => {
  const page = { state: 'ready', revision: 'r1', members: [{ threadId: 't1', relation: 'direct' }], nextCursor: null, coverage: { state: 'partial', excluded: 2 } };
  test('ready page with an added field', () => expect(PageOutputV1Schema.safeParse({ ...page, future: 1 }).success).toBe(true));
  test('closed failure', () => expect(PageOutputV1Schema.safeParse({ state: 'stale-scope', reason: 'scope-changed', message: 'Map changed.' }).success).toBe(true));
  test('unknown failure state', () => expect(PageOutputV1Schema.safeParse({ state: 'nope', reason: 'other', message: '' }).success).toBe(false));
  test('unknown coverage', () => expect(PageOutputV1Schema.safeParse({ ...page, coverage: { state: 'mostly' } }).success).toBe(false));
  test('too many members', () => expect(PageOutputV1Schema.safeParse({ ...page, members: Array.from({ length: LIMITS.pageMembers + 1 }, (_, i) => ({ threadId: `t${i}`, relation: 'direct' })) }).success).toBe(false));
});

describe('page violations', () => {
  const input = { scope: null, cursor: 'c1', limit: 2 };
  const ready = (members: string[], nextCursor: string | null = null) => PageOutputV1Schema.parse({ state: 'ready', revision: 'r', members: members.map(threadId => ({ threadId, relation: 'direct' })), nextCursor, coverage: { state: 'complete' } });
  test('more than requested', () => expect(pageViolation(input, ready(['a', 'b', 'c']))).toMatch(/More members/));
  test('duplicates', () => expect(pageViolation(input, ready(['a', 'a']))).toMatch(/Duplicate/));
  test('cursor did not advance', () => expect(pageViolation(input, ready(['a'], 'c1'))).toMatch(/Cursor/));
  test('valid', () => expect(pageViolation(input, ready(['a'], 'c2'))).toBeNull());
});

test('canonical JSON sorts keys and refuses non-JSON', () => {
  expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  expect(() => canonicalJson(Number.NaN)).toThrow();
  expect(() => canonicalJson(new Map())).toThrow();
});

test('method names are fixed', () => expect(METHODS).toEqual({ describe: 'threadMembershipV1Describe', page: 'threadMembershipV1Page' }));

describe('plain-JSON snapshot (review findings 1–2)', () => {
  test('sparse arrays are rejected everywhere they could reach the wire', () => {
    const sparse = Array(2);
    expect(() => canonicalJson(sparse)).toThrow();
    expect(ScopeSchema.safeParse(sparse).success).toBe(false);
    expect(PageInputV1Schema.safeParse({ scope: sparse, cursor: null, limit: 1 }).success).toBe(false);
    expect(ScopeSchema.safeParse([1, , 3]).success).toBe(false); // eslint-disable-line no-sparse-arrays
  });
  test('serialization hooks and accessors are refused without being invoked', () => {
    const hidden = { map: 'expected' };
    Object.defineProperty(hidden, 'toJSON', { value: () => ({ map: 'other-scope' }), enumerable: false });
    expect(ScopeSchema.safeParse(hidden).success).toBe(false);
    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'map', { get: () => { reads++; return 'x'; }, enumerable: true });
    expect(ScopeSchema.safeParse(accessor).success).toBe(false);
    expect(reads).toBe(0);
    expect(ScopeSchema.safeParse({ [Symbol('s')]: 1 }).success).toBe(false);
    expect(ScopeSchema.safeParse(new Date(0)).success).toBe(false);
    expect(ScopeSchema.safeParse(Object.assign([1], { extra: true })).success).toBe(false);
    const arrayHook = [1, 2];
    Object.defineProperty(arrayHook, 'map', { value: () => { throw new Error('invoked'); }, enumerable: false });
    expect(ScopeSchema.safeParse(arrayHook).success).toBe(false);
  });
  test('accepted scopes are detached plain data; __proto__ stays an ordinary key', () => {
    const original = { map: 'm', topics: ['a', 'b'], nested: { k: 1 } };
    const parsed = ScopeSchema.parse(original) as { map: string; topics: string[]; nested: { k: number } };
    original.map = 'changed'; original.topics.push('c'); original.nested.k = 2;
    expect(parsed).toEqual({ map: 'm', topics: ['a', 'b'], nested: { k: 1 } });
    const withProto = JSON.parse('{"__proto__":{"polluted":true}}');
    const snapshot = ScopeSchema.parse(withProto) as Record<string, unknown>;
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.keys(snapshot)).toEqual(['__proto__']);
    expect(ScopeSchema.parse(Object.assign(Object.create(null), { a: 1 }))).toEqual({ a: 1 });
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"polluted":true}}');
  });
});

describe('R5: no hidden whole-JSON depth policy; budgets are explicit', () => {
  const nest = (levels: number): unknown => { let v: unknown = 'leaf'; for (let i = 0; i < levels; i++) v = { d: v }; return v; };
  const deepArray = (levels: number): unknown => { let v: unknown = 0; for (let i = 0; i < levels; i++) v = [v]; return v; };
  test('a 70-level additive field is ordinary JSON: canonical, schema-accepted', () => {
    const page = { state: 'ready', revision: 'r', members: [], nextCursor: null, coverage: { state: 'complete' }, future: nest(70) };
    expect(() => canonicalJson(page)).not.toThrow();
    expect(PageOutputV1Schema.safeParse(page).success).toBe(true);
  });
  test('100k levels: no recursion overflow; budgets reject without throwing stack errors', () => {
    const deep = deepArray(100_000);
    expect(canonicalJson(deep).length).toBe(200_001);
    expect(canonicalJsonWithin(deep, 1000)).toBeNull();
    expect(() => plainJsonSnapshot(deep, { maxNodes: 1000 })).toThrow(RangeError);
  });
  test('byte budget is exact UTF-8 at the boundary', () => {
    const value = { k: 'é😀' };
    const text = canonicalJson(value);
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(canonicalJsonWithin(value, bytes)).toBe(text);
    expect(canonicalJsonWithin(value, bytes - 1)).toBeNull();
    expect(() => canonicalJsonWithin({ k: Number.NaN }, 100)).toThrow(TypeError);
  });
  test('scope stays strict: depth 6 and 1024 bytes', () => {
    expect(ScopeSchema.safeParse(nest(6)).success).toBe(true);
    expect(ScopeSchema.safeParse(nest(7)).success).toBe(false);
    expect(ScopeSchema.safeParse(Array.from({ length: 2000 }, () => 0)).success).toBe(false);
    expect(ScopeSchema.safeParse(deepArray(100_000)).success).toBe(false);
  });
});

describe('R5: shared children versus cycles', () => {
  test('a plain child referenced twice is copied twice; a true cycle is rejected', () => {
    const shared = { k: 1 };
    const dag = { a: shared, b: [shared, shared] };
    expect(canonicalJson(dag)).toBe('{"a":{"k":1},"b":[{"k":1},{"k":1}]}');
    const snapshot = plainJsonSnapshot(dag) as { a: object; b: object[] };
    expect(snapshot.a).not.toBe(snapshot.b[0]);
    expect(ScopeSchema.safeParse(dag).success).toBe(true);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    expect(ScopeSchema.safeParse(cyclic).success).toBe(false);
    const loop: unknown[] = [];
    loop.push([loop]);
    expect(() => canonicalJson(loop)).toThrow(TypeError);
    expect(() => canonicalJsonWithin(loop, 10_000)).toThrow(TypeError);
  });
});
