import assert from "node:assert/strict"
import test from "node:test"

import { createClickSuppression } from "../create-gesture.ts"

test("keeps drag suppression until the synthesized click consumes it", async () => {
  const suppression = createClickSuppression()
  suppression.beginPointerGesture()
  suppression.suppressNextButtonClick()

  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.equal(suppression.consumeButtonClick(), true)
  assert.equal(suppression.consumeButtonClick(), false)
})

test("clears stale suppression when a new pointer gesture starts", () => {
  const suppression = createClickSuppression()
  suppression.suppressNextButtonClick()
  suppression.beginPointerGesture()

  assert.equal(suppression.consumeButtonClick(), false)
})
