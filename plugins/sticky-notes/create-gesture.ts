export type CreateClickSource = "button" | "plus-menu"

export type CreateClickSuppression = {
  beginPointerGesture(): void
  suppressNextButtonClick(): void
  consumeButtonClick(): boolean
}

/**
 * Keeps a drag's synthesized button click suppression tied to the gesture.
 * A timeout is not suitable here because browsers may dispatch click in a
 * later task than pointerup, especially for touch input.
 */
export function createClickSuppression(): CreateClickSuppression {
  let suppressButtonClick = false

  return {
    beginPointerGesture() {
      suppressButtonClick = false
    },
    suppressNextButtonClick() {
      suppressButtonClick = true
    },
    consumeButtonClick() {
      if (!suppressButtonClick) return false
      suppressButtonClick = false
      return true
    },
  }
}
