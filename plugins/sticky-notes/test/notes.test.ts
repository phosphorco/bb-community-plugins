import assert from "node:assert/strict"
import test from "node:test"

import { stickyNotePatchSchema } from "../notes.ts"
import { reconcileAcknowledgedPatch, reconcileNoteSnapshot } from "../note-state.ts"

test("note updates cannot change persisted dimensions", () => {
  assert.equal(stickyNotePatchSchema.safeParse({ width: 320 }).success, false)
  assert.equal(stickyNotePatchSchema.safeParse({ height: 240 }).success, false)
  assert.equal(stickyNotePatchSchema.safeParse({ offsetX: 24, rotation: 2 }).success, true)
})

test("persisted links accept only normalized HTTP(S) URLs and derive their domain", () => {
  const normalized = stickyNotePatchSchema.parse({
    links: [{ url: "https://example.com/a#fragment", domain: "spoofed.example", title: null }],
  })
  assert.deepEqual(normalized.links, [{ url: "https://example.com/a", domain: "example.com", title: null }])
  assert.equal(stickyNotePatchSchema.safeParse({
    links: [{ url: "file:///private", domain: "private", title: null }],
  }).success, false)
})

test("an acknowledged placement patch cannot overwrite newer local text", () => {
  const current = {
    id: "note-1",
    threadId: "thread-1",
    text: "new local text",
    links: [],
    hueIndex: 0,
    horizontalAnchor: "left" as const,
    verticalAnchor: "top" as const,
    offsetX: 10,
    offsetY: 10,
    width: 250,
    height: 180,
    rotation: 0,
    createdAt: 1,
    updatedAt: 3,
  }
  const acknowledged = { ...current, text: "stale server text", offsetX: 40, updatedAt: 2 }
  assert.deepEqual(
    reconcileAcknowledgedPatch(current, acknowledged, { offsetX: 40 }),
    { ...current, offsetX: 40 },
  )
})

test("a stale list response cannot replace a newer acknowledged note", () => {
  const current = {
    id: "note-1",
    threadId: "thread-1",
    text: "new",
    links: [],
    hueIndex: 0,
    horizontalAnchor: "left" as const,
    verticalAnchor: "top" as const,
    offsetX: 10,
    offsetY: 10,
    width: 250,
    height: 180,
    rotation: 0,
    createdAt: 1,
    updatedAt: 3,
  }
  const stale = { ...current, text: "old", updatedAt: 2 }
  assert.deepEqual(reconcileNoteSnapshot([current], [stale]), [current])
  assert.deepEqual(reconcileNoteSnapshot([current], []), [])
})
