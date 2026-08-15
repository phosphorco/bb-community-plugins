import assert from "node:assert/strict"
import test from "node:test"

import {
  largestFittingFontSize,
  preferredWrapStyles,
} from "../typography.ts"

test("finds the largest fitting half-pixel size", () => {
  assert.equal(largestFittingFontSize((size) => size <= 37.5), 37.5)
})

test("keeps the 16px accessibility floor when nothing fits", () => {
  assert.equal(largestFittingFontSize(() => false), 16)
})

test("balances short notes and prettifies longer notes", () => {
  assert.deepEqual(preferredWrapStyles(5), ["balance", "pretty"])
  assert.deepEqual(preferredWrapStyles(6), ["pretty", "balance"])
})
