import assert from "node:assert/strict"
import test from "node:test"

import { ConfirmedNoteContentSaveQueue, ConfirmedTextSaveQueue } from "../save-queue.ts"

test("a rejected text save remains retryable", async () => {
  const queue = new ConfirmedTextSaveQueue("old")
  let attempts = 0
  const save = async () => ++attempts > 1
  assert.equal(await queue.enqueue("new", save), "old")
  assert.equal(await queue.enqueue("new", save), "new")
  assert.equal(attempts, 2)
})

test("text saves are serialized in enqueue order", async () => {
  const queue = new ConfirmedTextSaveQueue("")
  const started: string[] = []
  let releaseFirst: (() => void) | undefined
  const first = queue.enqueue("first", async (text) => {
    started.push(text)
    await new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    return true
  })
  const second = queue.enqueue("second", async (text) => {
    started.push(text)
    return true
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(started, ["first"])
  releaseFirst?.()
  assert.equal(await first, "first")
  assert.equal(await second, "second")
  assert.deepEqual(started, ["first", "second"])
})

test("citation conversion persists text and links in one ordered mutation", async () => {
  const queue = new ConfirmedNoteContentSaveQueue({ text: "Look at (1.)\nhttps://example.com", links: [] })
  const writes: Array<{ text: string; links: number }> = []
  const result = await queue.enqueue({
    text: "Look at (1.)\n",
    links: [{ url: "https://example.com/", domain: "example.com", title: null }],
  }, async (content) => {
    writes.push({ text: content.text, links: content.links.length })
    return true
  })
  assert.deepEqual(writes, [{ text: "Look at (1.)\n", links: 1 }])
  assert.equal(result.text, "Look at (1.)\n")
  assert.equal(result.links.length, 1)
})
