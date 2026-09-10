import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import type { Annotation, BbContext } from "../lib/afs.ts";
import { encodeAgentationAttachment } from "../lib/attachment.ts";
import plugin from "../server.ts";
import { openSession, upsertAnnotation } from "../lib/store.ts";

type MentionProvider = {
  resolve(itemId: string): { context: string } | Promise<{ context: string }>;
};

function makeBb(
  db: Database.Database,
  providers: MentionProvider[],
): Record<string, unknown> {
  const disposers: Array<() => void | Promise<void>> = [];
  return {
    pluginId: "agentation-mentions",
    log: { info() {}, warn() {} },
    settings: {
      define() {
        return {
          async get() {
            return { retentionDays: "7" };
          },
          onChange() {},
        };
      },
    },
    storage: {
      database() {
        return db;
      },
      migrate(database: Database.Database, statements: string[]) {
        for (const statement of statements) database.exec(statement);
      },
      kv: {
        async get() {
          return undefined;
        },
        async set() {},
      },
    },
    http: { route() {} },
    rpc: { register() {} },
    realtime: { publish() {} },
    background: { schedule() {} },
    cli: { register() {} },
    agents: {
      registerTool() {},
      contributeInstructions() {},
    },
    ui: {
      registerMentionProvider(provider: MentionProvider) {
        providers.push(provider);
      },
    },
    sdk: {
      threads: {
        async send() {
          return { ok: true };
        },
      },
      plugins: {
        async callRpc() {
          return null;
        },
      },
    },
    onDispose(hook: () => void | Promise<void>) {
      disposers.push(hook);
    },
  };
}

test("Agentation resolver returns plain context for host-owned attachment assembly", async () => {
  const db = new Database(":memory:");
  const providers: MentionProvider[] = [];
  const bb = makeBb(db, providers);

  try {
    await plugin(bb as never);

    const session = openSession(db, {
      url: "http://localhost/plugins/github/issues",
      route: "/plugins/github/issues",
      title: "Issues",
      threadId: "thr_mention",
      projectId: "proj_mention",
    });
    const annotation = upsertAnnotation(db, {
      sessionId: session.id,
      annotation: {
        id: "ann_native_boundary",
        comment: "Keep this context attached",
        elementPath: "body > main > button.cta",
        timestamp: 1_760_000_000_000,
        x: 40,
        y: 200,
        element: "button",
      } satisfies Annotation,
      bb: {
        route: "/plugins/github/issues",
        pluginId: "github",
        surface: "issues",
        threadId: "thr_mention",
        projectId: "proj_mention",
        routeLabel: "github issues",
      } satisfies BbContext,
    });

    const provider = providers.find((candidate) => candidate.resolve);
    assert.ok(provider, "Agentation should register its mention provider");

    const resolved = await provider.resolve(
      encodeAgentationAttachment({ annotationIds: [annotation.id] }),
    );
    assert.doesNotMatch(resolved.context, /^\s*<attached>/u);
    assert.doesNotMatch(resolved.context, /\[sender=/u);

    assert.match(resolved.context, /Keep this context attached/u);
    assert.match(resolved.context, /Resolve each item with/u);
  } finally {
    db.close();
  }
});
