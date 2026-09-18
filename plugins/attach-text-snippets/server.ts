import { randomUUID } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./rpc-contract.ts";
import {
  absoluteSnippetPath,
  escapeSqlLike,
  MAX_SNIPPET_BYTES,
  normalizeSnippetTitle,
  snippetMentionContext,
  snippetRelativePath,
  type StoredSnippet,
} from "./snippet-model.ts";

type StoredSnippetRow = {
  id: string;
  thread_id: string;
  title: string;
  relative_path: string;
  size_bytes: number;
  created_at: number;
  host_id: string | null;
  storage_root_path: string | null;
  delete_pending: number;
};

const MENTION_PROVIDER_ID = "attach-text-snippets";

function fromRow(row: StoredSnippetRow): StoredSnippet {
  return {
    id: row.id,
    threadId: row.thread_id,
    title: row.title,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

function sizeLabel(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  return `${Math.ceil(sizeBytes / 1_024)} KB`;
}

export async function insertSnippetWithRollback(
  insertSnippet: () => void,
  removeCreatedFile: () => Promise<void>,
  warn: (message: string) => void,
): Promise<void> {
  try {
    insertSnippet();
  } catch (cause) {
    try {
      await removeCreatedFile();
    } catch (cleanupCause) {
      const detail = cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause);
      warn(`Could not remove a text snippet after its metadata insert failed: ${detail}`);
    }
    throw cause;
  }
}

export default function attachTextSnippetsPlugin(bb: BbPluginApi): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS attach_text_snippets (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attach_text_snippets_thread_created
      ON attach_text_snippets(thread_id, created_at DESC);`,
    "ALTER TABLE attach_text_snippets ADD COLUMN host_id TEXT;",
    "ALTER TABLE attach_text_snippets ADD COLUMN storage_root_path TEXT;",
    "ALTER TABLE attach_text_snippets ADD COLUMN delete_pending INTEGER NOT NULL DEFAULT 0;",
  ]);

  const insert = db.prepare(`INSERT INTO attach_text_snippets (
    id, thread_id, title, relative_path, size_bytes, created_at, host_id, storage_root_path
  ) VALUES (
    @id, @thread_id, @title, @relative_path, @size_bytes, @created_at, @host_id, @storage_root_path
  )`);
  const readOne = db.prepare("SELECT * FROM attach_text_snippets WHERE id = ? AND delete_pending = 0");
  const searchThread = db.prepare(`SELECT * FROM attach_text_snippets
    WHERE thread_id = ? AND delete_pending = 0 AND lower(title) LIKE ? ESCAPE '\\'
    ORDER BY created_at DESC
    LIMIT 20`);
  const removeThread = db.prepare("DELETE FROM attach_text_snippets WHERE thread_id = ?");
  const markThreadDeleting = db.prepare("UPDATE attach_text_snippets SET delete_pending = 1 WHERE thread_id = ?");
  const pendingCleanup = db.prepare(`SELECT thread_id, host_id, storage_root_path
    FROM attach_text_snippets
    WHERE delete_pending = 1 AND host_id IS NOT NULL AND storage_root_path IS NOT NULL
    GROUP BY thread_id, host_id, storage_root_path`);

  const cleanPendingThreads = async (): Promise<void> => {
    const rows = pendingCleanup.all() as Array<{
      thread_id: string;
      host_id: string;
      storage_root_path: string;
    }>;
    for (const row of rows) {
      const path = absoluteSnippetPath(row.storage_root_path, "attach-text-snippets");
      try {
        await bb.sdk.files.remove({
          hostId: row.host_id,
          path,
          rootPath: row.storage_root_path,
          recursive: true,
        });
        removeThread.run(row.thread_id);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`Text snippet cleanup remains pending for ${row.thread_id}: ${detail}`);
      }
    }
  };

  bb.rpc.register(rpcContract, {
    async createSnippet({ threadId, title, content }) {
      if (content.trim().length === 0) {
        throw new Error("Paste some text before creating a snippet.");
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes > MAX_SNIPPET_BYTES) {
        throw new Error("Text snippets can be at most 1 MB.");
      }

      const now = Date.now();
      const id = randomUUID();
      const normalizedTitle = normalizeSnippetTitle(title, now);
      const relativePath = snippetRelativePath(normalizedTitle, id);
      const storage = await bb.sdk.threads.storageLocation({ threadId });
      const path = absoluteSnippetPath(storage.storageRootPath, relativePath);
      const written = await bb.sdk.files.write({
        hostId: storage.hostId,
        path,
        rootPath: storage.storageRootPath,
        content,
        createParents: true,
        expectedSha256: null,
        mode: 0o600,
      });
      if (written.outcome === "conflict") {
        throw new Error("A text snippet already exists at the generated path. Try again.");
      }

      const snippet: StoredSnippet = {
        id,
        threadId,
        title: normalizedTitle,
        relativePath,
        sizeBytes,
        createdAt: now,
      };
      await insertSnippetWithRollback(
        () => {
          insert.run({
            id: snippet.id,
            thread_id: snippet.threadId,
            title: snippet.title,
            relative_path: snippet.relativePath,
            size_bytes: snippet.sizeBytes,
            created_at: snippet.createdAt,
            host_id: storage.hostId,
            storage_root_path: storage.storageRootPath,
          });
        },
        async () => {
          await bb.sdk.files.remove({
            hostId: storage.hostId,
            path,
            rootPath: storage.storageRootPath,
          });
        },
        (message) => bb.log.warn(message),
      );
      return {
        snippet: {
          id: snippet.id,
          label: snippet.title,
          relativePath: snippet.relativePath,
          sizeBytes: snippet.sizeBytes,
          createdAt: snippet.createdAt,
        },
      };
    },
  });

  bb.ui.registerMentionProvider({
    id: MENTION_PROVIDER_ID,
    label: "Text snippets",
    search({ threadId, query }) {
      if (threadId === null) return [];
      const like = `%${escapeSqlLike(query.trim().toLowerCase())}%`;
      const rows = searchThread.all(threadId, like) as StoredSnippetRow[];
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        subtitle: `${sizeLabel(row.size_bytes)} · thread storage`,
        icon: "FileText",
      }));
    },
    async resolve(itemId) {
      const row = readOne.get(itemId) as StoredSnippetRow | undefined;
      if (!row) throw new Error("This text snippet is no longer available.");
      const snippet = fromRow(row);
      const storage = await bb.sdk.threads.storageLocation({ threadId: snippet.threadId });
      const path = absoluteSnippetPath(storage.storageRootPath, snippet.relativePath);
      const existence = await bb.sdk.hosts.pathsExist({ hostId: storage.hostId, paths: [path] });
      if (!existence.existence[path]) {
        throw new Error("This text snippet file is no longer available. Remove the mention or create it again.");
      }
      return { context: snippetMentionContext(snippet, path) };
    },
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    markThreadDeleting.run(thread.id);
    void cleanPendingThreads();
  });

  bb.background.service("attach-text-snippets-cleanup", {
    async start(signal) {
      await cleanPendingThreads();
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}
