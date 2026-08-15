import assert from "node:assert/strict"
import test from "node:test"

import { ConfirmedTextSaveQueue } from "../save-queue.ts"

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
