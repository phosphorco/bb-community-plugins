import assert from "node:assert/strict"
import test from "node:test"

import {
  anchorPlacement,
  isBelowViewport,
  noteSizeForBounds,
  placementCenteredAt,
  pointIsWithinBounds,
  resolvePlacement,
} from "../geometry.ts"

test("anchors a note to the nearest horizontal and vertical edges", () => {
  const bounds = { width: 1000, height: 700 }
  assert.deepEqual(
    anchorPlacement({ left: 40, top: 420, width: 240, height: 160, rotation: 2 }, bounds),
    {
      horizontalAnchor: "left",
      verticalAnchor: "bottom",
      offsetX: 40,
      offsetY: 120,
      width: 240,
      height: 160,
      rotation: 2,
    },
  )
})

test("right and bottom anchors preserve edge distance when bounds resize", () => {
  const layout = anchorPlacement(
    { left: 710, top: 500, width: 240, height: 160, rotation: -1.5 },
    { width: 1000, height: 700 },
  )
  assert.deepEqual(
    resolvePlacement(layout, { width: 800, height: 600 }),
    { left: 530, top: 404, width: 220, height: 156, rotation: -1.5 },
  )
})

test("all edge anchors preserve their nearest-edge offsets", () => {
  const bounds = { width: 900, height: 700 }
  for (const placement of [
    { left: 20, top: 30, width: 240, height: 160, rotation: 0 },
    { left: 640, top: 30, width: 240, height: 160, rotation: 0 },
    { left: 20, top: 510, width: 240, height: 160, rotation: 0 },
    { left: 640, top: 510, width: 240, height: 160, rotation: 0 },
    { left: 330, top: 270, width: 240, height: 160, rotation: 0 },
  ]) {
    const layout = anchorPlacement(placement, bounds)
    const resolved = resolvePlacement(layout, bounds)
    assert.equal(resolved.left, layout.horizontalAnchor === "left" ? layout.offsetX : bounds.width - layout.offsetX - resolved.width)
    assert.equal(resolved.top, layout.verticalAnchor === "top" ? layout.offsetY : bounds.height - layout.offsetY - resolved.height)
  }
  const tie = anchorPlacement({ left: 330, top: 270, width: 240, height: 160, rotation: 0 }, bounds)
  assert.equal(tie.horizontalAnchor, "left")
  assert.equal(tie.verticalAnchor, "top")
})

test("an edge-anchored note restores its offset after shrinking and expanding", () => {
  const large = { width: 1000, height: 700 }
  const layout = anchorPlacement(
    { left: 720, top: 500, width: 250, height: 180, rotation: 1 },
    large,
  )
  assert.deepEqual(resolvePlacement(layout, { width: 320, height: 240 }), {
    left: 110,
    top: 80,
    width: 180,
    height: 140,
    rotation: 1,
  })
  assert.deepEqual(resolvePlacement(layout, large), {
    left: 750,
    top: 524,
    width: 220,
    height: 156,
    rotation: 1,
  })
})

test("note size scales smoothly down from a smaller desktop cap", () => {
  assert.deepEqual(noteSizeForBounds({ width: 1000, height: 700 }), { width: 220, height: 156 })
  assert.deepEqual(noteSizeForBounds({ width: 600, height: 700 }), { width: 216, height: 153 })
  assert.deepEqual(noteSizeForBounds({ width: 390, height: 700 }), { width: 180, height: 140 })
})

test("responsive sizing keeps right and bottom anchors visible on mobile", () => {
  const layout = {
    horizontalAnchor: "right" as const,
    verticalAnchor: "bottom" as const,
    offsetX: 20,
    offsetY: 20,
    width: 220,
    height: 156,
    rotation: 0,
  }
  assert.deepEqual(resolvePlacement(layout, { width: 390, height: 600 }), {
    left: 190,
    top: 440,
    width: 180,
    height: 140,
    rotation: 0,
  })
})

test("crossing the viewport bottom deliberately enters discard mode", () => {
  const note = { left: 20, top: 450, width: 220, height: 150, rotation: 0 }
  assert.equal(isBelowViewport(note, 200, 800), false)
  assert.equal(isBelowViewport({ ...note, top: 459 }, 200, 800), true)
})

test("clamps saved and restored dimensions to the schema maximum", () => {
  assert.deepEqual(
    placementCenteredAt(
      { x: 500, y: 500 },
      { width: 1000, height: 1000 },
      { width: 900, height: 800 },
    ),
    { left: 140, top: 140, width: 720, height: 720, rotation: 0 },
  )
})

test("centers a dragged note at the pointer and clamps it to the thread", () => {
  const bounds = { width: 800, height: 600 }
  assert.deepEqual(
    placementCenteredAt({ x: 400, y: 300 }, bounds, { width: 250, height: 180 }, 2),
    { left: 275, top: 210, width: 250, height: 180, rotation: 2 },
  )
  assert.deepEqual(
    placementCenteredAt({ x: 10, y: 10 }, bounds, { width: 250, height: 180 }),
    { left: 0, top: 0, width: 250, height: 180, rotation: 0 },
  )
})

test("only accepts drops inside the thread placement bounds", () => {
  const bounds = { width: 800, height: 600 }
  assert.equal(pointIsWithinBounds({ x: 800, y: 600 }, bounds), true)
  assert.equal(pointIsWithinBounds({ x: 801, y: 300 }, bounds), false)
})
