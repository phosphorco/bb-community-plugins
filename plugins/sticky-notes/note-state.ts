import type { StickyNote, StickyNotePatch } from "./notes.ts"

export function reconcileAcknowledgedPatch(
  current: StickyNote,
  acknowledged: StickyNote,
  patch: StickyNotePatch,
): StickyNote {
  const next = {
    ...current,
    updatedAt: Math.max(current.updatedAt, acknowledged.updatedAt),
  }
  if (patch.text !== undefined) next.text = acknowledged.text
  if (patch.horizontalAnchor !== undefined) next.horizontalAnchor = acknowledged.horizontalAnchor
  if (patch.verticalAnchor !== undefined) next.verticalAnchor = acknowledged.verticalAnchor
  if (patch.offsetX !== undefined) next.offsetX = acknowledged.offsetX
  if (patch.offsetY !== undefined) next.offsetY = acknowledged.offsetY
  if (patch.rotation !== undefined) next.rotation = acknowledged.rotation
  return next
}

export function reconcileNoteSnapshot(
  current: readonly StickyNote[],
  incoming: readonly StickyNote[],
): StickyNote[] {
  const currentById = new Map(current.map((note) => [note.id, note]))
  return incoming.map((note) => {
    const existing = currentById.get(note.id)
    return existing && existing.updatedAt > note.updatedAt ? existing : note
  })
}
