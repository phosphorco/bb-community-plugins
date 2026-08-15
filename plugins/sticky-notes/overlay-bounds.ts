export interface RectBounds {
  left: number
  top: number
  width: number
  height: number
}

export type OverlayBounds = RectBounds

export function intersectPaneBounds(
  pane: RectBounds,
  viewport: RectBounds,
  topInset: number,
  minimum: { width: number; height: number },
): OverlayBounds | null {
  const left = Math.max(viewport.left, pane.left)
  const top = Math.max(viewport.top, pane.top + topInset)
  const right = Math.min(viewport.left + viewport.width, pane.left + pane.width)
  const bottom = Math.min(viewport.top + viewport.height, pane.top + pane.height)
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  return width >= minimum.width && height >= minimum.height
    ? { left, top, width, height }
    : null
}
