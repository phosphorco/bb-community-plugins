import { z } from "zod"

export const HUE_COUNT = 12
export const NOTE_WIDTH = 220
export const NOTE_HEIGHT = 156

export const horizontalAnchorSchema = z.enum(["left", "right"])
export const verticalAnchorSchema = z.enum(["top", "bottom"])

export const noteLayoutSchema = z.object({
  horizontalAnchor: horizontalAnchorSchema,
  verticalAnchor: verticalAnchorSchema,
  offsetX: z.number().finite().min(0),
  offsetY: z.number().finite().min(0),
  width: z.number().finite().min(180).max(720),
  height: z.number().finite().min(140).max(720),
  rotation: z.number().finite().min(-6).max(6),
})

export const stickyNoteSchema = noteLayoutSchema.extend({
  id: z.string().min(1),
  threadId: z.string().min(1),
  text: z.string().max(20_000),
  hueIndex: z.number().int().min(0).max(HUE_COUNT - 1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export const stickyNotePatchSchema = noteLayoutSchema
  .pick({
    horizontalAnchor: true,
    verticalAnchor: true,
    offsetX: true,
    offsetY: true,
    rotation: true,
  })
  .partial()
  .extend({ text: z.string().max(20_000).optional() })
  .strict()

export type NoteLayout = z.infer<typeof noteLayoutSchema>
export type StickyNote = z.infer<typeof stickyNoteSchema>
export type StickyNotePatch = z.infer<typeof stickyNotePatchSchema>
