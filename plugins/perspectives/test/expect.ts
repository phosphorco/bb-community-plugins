import assert from "node:assert/strict";

export function expect(actual: any) {
  return {
    toBe(expected: any) {
      assert.equal(actual, expected);
    },
    toEqual(expected: any) {
      assert.deepEqual(actual, expected);
    },
    toHaveLength(expected: number) {
      assert.equal(actual.length, expected);
    },
    toContain(expected: any) {
      assert.ok(actual.includes(expected));
    },
    toThrow(expected: string | RegExp) {
      assert.throws(actual, expected instanceof RegExp ? expected : new RegExp(expected));
    },
    not: {
      toContain(expected: any) {
        assert.ok(!actual.includes(expected));
      },
    },
  };
}
