import { z } from "zod"

export const HUE_COUNT = 12
export const NOTE_WIDTH = 220
export const NOTE_HEIGHT = 156

export const horizontalAnchorSchema = z.enum(["left", "right"])
export const verticalAnchorSchema = z.enum(["top", "bottom"])

const webUrlSchema = z.string().max(4_096).transform((value, context) => {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol")
    url.hash = ""
    return url.toString()
  } catch {
    context.addIssue({ code: "custom", message: "Expected an HTTP(S) URL" })
    return z.NEVER
  }
})

export const stickyNoteLinkSchema = z.object({
  url: webUrlSchema,
  domain: z.string().min(1).max(253),
  title: z.string().max(300).nullable(),
}).strict().transform((link) => ({
  url: link.url,
  domain: new URL(link.url).hostname,
  title: link.title,
}))

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
  links: z.array(stickyNoteLinkSchema).max(50),
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
  .extend({
    text: z.string().max(20_000).optional(),
    links: z.array(stickyNoteLinkSchema).max(50).optional(),
  })
  .strict()

export type NoteLayout = z.infer<typeof noteLayoutSchema>
export type StickyNoteLink = z.infer<typeof stickyNoteLinkSchema>
export type StickyNote = z.infer<typeof stickyNoteSchema>
export type StickyNotePatch = z.infer<typeof stickyNotePatchSchema>
