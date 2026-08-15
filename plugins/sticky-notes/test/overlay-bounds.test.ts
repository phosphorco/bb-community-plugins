import assert from "node:assert/strict"
import test from "node:test"

import { intersectPaneBounds } from "../overlay-bounds.ts"

const minimum = { width: 180, height: 140 }

test("intersects a pane with an offset visual viewport and top inset", () => {
  assert.deepEqual(
    intersectPaneBounds(
      { left: 10, top: 20, width: 800, height: 700 },
      { left: 40, top: 80, width: 600, height: 420 },
      48,
      minimum,
    ),
    { left: 40, top: 80, width: 600, height: 420 },
  )
})

test("rejects a keyboard-occluded intersection smaller than a note", () => {
  assert.equal(
    intersectPaneBounds(
      { left: 0, top: 0, width: 500, height: 700 },
      { left: 0, top: 561, width: 500, height: 139 },
      48,
      minimum,
    ),
    null,
  )
})

test("accepts the exact minimum intersection", () => {
  assert.deepEqual(
    intersectPaneBounds(
      { left: 0, top: 0, width: 180, height: 188 },
      { left: 0, top: 0, width: 180, height: 188 },
      48,
      minimum,
    ),
    { left: 0, top: 48, width: 180, height: 140 },
  )
})
