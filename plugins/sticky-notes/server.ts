import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk"
import { z } from "zod"

import {
  HUE_COUNT,
  NOTE_HEIGHT,
  NOTE_WIDTH,
  noteLayoutSchema,
  stickyNotePatchSchema,
  stickyNoteSchema,
  type StickyNote,
} from "./notes.ts"

type StoredNoteRow = {
  id: string
  thread_id: string
  text: string
  hue_index: number
  horizontal_anchor: "left" | "right"
  vertical_anchor: "top" | "bottom"
  offset_x: number
  offset_y: number
  width: number
  height: number
  rotation: number
  created_at: number
  updated_at: number
}

const threadInput = z.object({ threadId: z.string().min(1) }).strict()

export const rpcContract = defineRpcContract({
  listNotes: {
    input: threadInput,
    output: z.object({ notes: z.array(stickyNoteSchema) }),
  },
  createNote: {
    input: threadInput.extend({
      layout: noteLayoutSchema,
      hueIndex: z.number().int().min(0).max(HUE_COUNT - 1).optional(),
    }).strict(),
    output: z.object({ note: stickyNoteSchema }),
  },
  updateNote: {
    input: threadInput.extend({
      id: z.string().min(1),
      patch: stickyNotePatchSchema,
    }).strict(),
    output: z.object({ note: stickyNoteSchema.nullable() }),
  },
  deleteNote: {
    input: threadInput.extend({ id: z.string().min(1) }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
})

function fromRow(row: StoredNoteRow): StickyNote {
  return {
    id: row.id,
    threadId: row.thread_id,
    text: row.text,
    hueIndex: row.hue_index,
    horizontalAnchor: row.horizontal_anchor,
    verticalAnchor: row.vertical_anchor,
    offsetX: row.offset_x,
    offsetY: row.offset_y,
    width: row.width,
    height: row.height,
    rotation: row.rotation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export default function stickyNotesPlugin(bb: BbPluginApi) {
  const db = bb.storage.database()
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS sticky_notes (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      hue_index INTEGER NOT NULL,
      horizontal_anchor TEXT NOT NULL,
      vertical_anchor TEXT NOT NULL,
      offset_x REAL NOT NULL,
      offset_y REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      rotation REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sticky_notes_thread_updated
      ON sticky_notes(thread_id, updated_at);`,
    `UPDATE sticky_notes
      SET width = ${NOTE_WIDTH}, height = ${NOTE_HEIGHT}
      WHERE width <> ${NOTE_WIDTH} OR height <> ${NOTE_HEIGHT};`,
  ])

  const readOne = db.prepare("SELECT * FROM sticky_notes WHERE id = ? AND thread_id = ?")
  const readThread = db.prepare("SELECT * FROM sticky_notes WHERE thread_id = ? ORDER BY created_at ASC")
  const insert = db.prepare(`INSERT INTO sticky_notes (
    id, thread_id, text, hue_index, horizontal_anchor, vertical_anchor,
    offset_x, offset_y, width, height, rotation, created_at, updated_at
  ) VALUES (
    @id, @thread_id, @text, @hue_index, @horizontal_anchor, @vertical_anchor,
    @offset_x, @offset_y, @width, @height, @rotation, @created_at, @updated_at
  )`)
  const update = db.prepare(`UPDATE sticky_notes SET
    text = @text,
    horizontal_anchor = @horizontal_anchor,
    vertical_anchor = @vertical_anchor,
    offset_x = @offset_x,
    offset_y = @offset_y,
    width = @width,
    height = @height,
    rotation = @rotation,
    updated_at = @updated_at
    WHERE id = @id AND thread_id = @thread_id`)
  const remove = db.prepare("DELETE FROM sticky_notes WHERE id = ? AND thread_id = ?")
  const removeThread = db.prepare("DELETE FROM sticky_notes WHERE thread_id = ?")

  const publish = (threadId: string) => bb.realtime.publish("notes", { threadId })

  bb.rpc.register(rpcContract, {
    listNotes({ threadId }) {
      return { notes: (readThread.all(threadId) as StoredNoteRow[]).map(fromRow) }
    },
    createNote({ threadId, layout, hueIndex }) {
      const now = Date.now()
      const row: StoredNoteRow = {
        id: crypto.randomUUID(),
        thread_id: threadId,
        text: "",
        hue_index: hueIndex ?? Math.floor(Math.random() * HUE_COUNT),
        horizontal_anchor: layout.horizontalAnchor,
        vertical_anchor: layout.verticalAnchor,
        offset_x: layout.offsetX,
        offset_y: layout.offsetY,
        width: NOTE_WIDTH,
        height: NOTE_HEIGHT,
        rotation: layout.rotation,
        created_at: now,
        updated_at: now,
      }
      insert.run(row)
      publish(threadId)
      return { note: fromRow(row) }
    },
    updateNote({ id, threadId, patch }) {
      const existing = readOne.get(id, threadId) as StoredNoteRow | undefined
      if (!existing) return { note: null }
      const row: StoredNoteRow = {
        ...existing,
        text: patch.text ?? existing.text,
        horizontal_anchor: patch.horizontalAnchor ?? existing.horizontal_anchor,
        vertical_anchor: patch.verticalAnchor ?? existing.vertical_anchor,
        offset_x: patch.offsetX ?? existing.offset_x,
        offset_y: patch.offsetY ?? existing.offset_y,
        width: existing.width,
        height: existing.height,
        rotation: patch.rotation ?? existing.rotation,
        updated_at: Date.now(),
      }
      update.run(row)
      publish(threadId)
      return { note: fromRow(row) }
    },
    deleteNote({ id, threadId }) {
      const deleted = remove.run(id, threadId).changes > 0
      if (deleted) publish(threadId)
      return { deleted }
    },
  })

  bb.events.on("thread.deleted", ({ thread }) => {
    removeThread.run(thread.id)
  })
}
