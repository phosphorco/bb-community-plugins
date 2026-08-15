import { NOTE_HEIGHT, NOTE_WIDTH, type NoteLayout } from "./notes.ts"

export interface Bounds {
  width: number
  height: number
}

export interface AbsolutePlacement {
  left: number
  top: number
  width: number
  height: number
  rotation: number
}

export interface Point {
  x: number
  y: number
}

export const MIN_NOTE_WIDTH = 180
export const MIN_NOTE_HEIGHT = 140
export const MAX_NOTE_WIDTH = 720
export const MAX_NOTE_HEIGHT = 720

/**
 * Use one responsive size for previews, new notes, and restored notes. The
 * desktop cap is deliberately compact; narrow panes progressively approach
 * the minimum without introducing breakpoint jumps.
 */
export function noteSizeForBounds(bounds: Bounds): { width: number; height: number } {
  const width = clamp(
    Math.round(bounds.width * 0.36),
    MIN_NOTE_WIDTH,
    Math.min(NOTE_WIDTH, bounds.width),
  )
  const height = clamp(
    Math.round(width * (NOTE_HEIGHT / NOTE_WIDTH)),
    MIN_NOTE_HEIGHT,
    Math.min(NOTE_HEIGHT, bounds.height),
  )
  return { width, height }
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export function resolvePlacement(layout: NoteLayout, bounds: Bounds): AbsolutePlacement {
  const { width, height } = noteSizeForBounds(bounds)
  const left = layout.horizontalAnchor === "left"
    ? layout.offsetX
    : bounds.width - layout.offsetX - width
  const top = layout.verticalAnchor === "top"
    ? layout.offsetY
    : bounds.height - layout.offsetY - height

  return clampPlacement({
    left,
    top,
    width,
    height,
    rotation: layout.rotation,
  }, bounds)
}

export function clampPlacement(placement: AbsolutePlacement, bounds: Bounds): AbsolutePlacement {
  const width = clamp(placement.width, MIN_NOTE_WIDTH, Math.min(MAX_NOTE_WIDTH, bounds.width))
  const height = clamp(placement.height, MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, bounds.height))
  return {
    ...placement,
    width,
    height,
    left: clamp(placement.left, 0, bounds.width - width),
    top: clamp(placement.top, 0, bounds.height - height),
  }
}

export function placementCenteredAt(
  point: Point,
  bounds: Bounds,
  size: { width: number; height: number },
  rotation = 0,
): AbsolutePlacement {
  const width = clamp(size.width, MIN_NOTE_WIDTH, Math.min(MAX_NOTE_WIDTH, bounds.width))
  const height = clamp(size.height, MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, bounds.height))
  return clampPlacement({
    left: point.x - width / 2,
    top: point.y - height / 2,
    width,
    height,
    rotation,
  }, bounds)
}

export function pointIsWithinBounds(point: Point, bounds: Bounds): boolean {
  return point.x >= 0 && point.x <= bounds.width && point.y >= 0 && point.y <= bounds.height
}

/**
 * Persist offsets from whichever horizontal and vertical edges are nearest.
 * This keeps a note attached to the intended edge as a split or window resizes.
 */
export function anchorPlacement(placement: AbsolutePlacement, bounds: Bounds): NoteLayout {
  const clamped = clampPlacement(placement, bounds)
  const right = Math.max(0, bounds.width - clamped.left - clamped.width)
  const bottom = Math.max(0, bounds.height - clamped.top - clamped.height)
  return {
    horizontalAnchor: clamped.left <= right ? "left" : "right",
    verticalAnchor: clamped.top <= bottom ? "top" : "bottom",
    offsetX: clamped.left <= right ? clamped.left : right,
    offsetY: clamped.top <= bottom ? clamped.top : bottom,
    width: clamped.width,
    height: clamped.height,
    rotation: clamp(clamped.rotation, -6, 6),
  }
}

export function isBelowViewport(
  placement: AbsolutePlacement,
  overlayTop: number,
  viewportBottom: number,
): boolean {
  return overlayTop + placement.top + placement.height > viewportBottom + 8
}
