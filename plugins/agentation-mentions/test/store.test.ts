import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import type { Annotation, AnnotationAuthor, BbContext } from "../lib/afs.ts";
import { storedAnnotationSchema } from "../lib/afs.ts";
import {
  appendThreadMessage,
  clearSession,
  countByStatus,
  deleteAnnotations,
  getAnnotation,
  listAnnotations,
  listSessions,
  migrations,
  openSession,
  pruneClosed,
  sessionCursor,
  setAnnotationStatus,
  upsertAnnotation,
} from "../lib/store.ts";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  return db;
}

function bbContext(overrides: Partial<BbContext> = {}): BbContext {
  return {
    route: "/threads/thr_abc",
    pluginId: null,
    surface: null,
    threadId: "thr_abc",
    projectId: null,
    routeLabel: "thread thr_abc",
    ...overrides,
  };
}

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann_1",
    comment: "The label wraps at 320px",
    elementPath: "body > main > button.cta",
    timestamp: 1_760_000_000_000,
    x: 40,
    y: 200,
    element: "button",
    ...overrides,
  } as Annotation;
}

const coleAuthor: AnnotationAuthor = {
  kind: "captured",
  identity: { kind: "person", key: "tailnet:cole", issuer: "tailnet", subject: "cole" },
  presentation: { displayName: "Cole", handle: "cole", avatarUrl: null },
  evidence: "provider-verified",
  capturedAt: "2026-09-06T12:00:00.000Z",
};

const machineAuthor: AnnotationAuthor = {
  kind: "captured",
  identity: { kind: "machine", key: "p6r-machine:v1:fixture-instance:server", instanceId: "fixture-instance", hostId: null },
  presentation: { displayName: "BB machine", handle: null, avatarUrl: null },
  evidence: "machine",
  capturedAt: "2026-09-06T12:00:00.000Z",
};

function seed(db: Database.Database, author: AnnotationAuthor | null = null) {
  const session = openSession(db, {
    url: "http://localhost:5173/threads/thr_abc",
    route: "/threads/thr_abc",
    title: "bb",
    threadId: "thr_abc",
    projectId: null,
  });
  const stored = upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation(),
    bb: bbContext(),
    author,
  });
  return { session, stored };
}

test("annotation authorship is captured once and cannot be claimed by an editor", () => {
  const db = freshDb();
  const { session, stored } = seed(db, coleAuthor);

  const edited = upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ id: stored.id, comment: "Edited feedback" }),
    bb: bbContext(),
    author: {
      ...coleAuthor,
      identity: { kind: "person", key: "tailnet:alex", issuer: "tailnet", subject: "alex" },
    },
  });

  assert.deepEqual(edited.author, coleAuthor);
});

test("a public host-relative avatar snapshot persists unchanged", () => {
  const db = freshDb();
  const author: AnnotationAuthor = {
    ...coleAuthor,
    presentation: { ...coleAuthor.presentation, avatarUrl: "/avatars/cole.jpg" },
  };
  const { stored } = seed(db, author);

  assert.deepEqual(stored.author, author);
  assert.deepEqual(getAnnotation(db, stored.id)?.author, author);
});

test("machine fallback author survives the durable annotation codec", () => {
  const db = freshDb();
  const { stored } = seed(db, machineAuthor);
  const row = db.prepare("SELECT payload FROM annotations WHERE id = ?").get(stored.id) as { payload: string };
  const decoded = storedAnnotationSchema.parse(JSON.parse(row.payload));
  assert.deepEqual(decoded.author, machineAuthor);
  assert.deepEqual(getAnnotation(db, stored.id)?.author, machineAuthor);
});

test("legacy author marker stays exact and cannot become the current author", () => {
  const db = freshDb();
  const { session, stored } = seed(db);
  const row = db.prepare("SELECT payload FROM annotations WHERE id = ?").get(stored.id) as { payload: string };
  const legacyPayload = JSON.parse(row.payload) as Record<string, unknown>;
  delete legacyPayload.author;
  db.prepare("UPDATE annotations SET payload = ? WHERE id = ?").run(
    JSON.stringify({ ...legacyPayload, authorIdentityId: "cole%40example.com" }),
    stored.id,
  );
  const edited = upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ comment: "edited" }),
    bb: bbContext(),
    author: coleAuthor,
  });
  assert.equal(edited.authorIdentityId, "cole%40example.com");
  assert.equal(edited.author, undefined);
});

test("a second visit to the same route joins the existing session", () => {
  const db = freshDb();
  const first = openSession(db, {
    url: "http://localhost/threads/thr_abc",
    route: "/threads/thr_abc",
    title: "bb",
    threadId: "thr_abc",
    projectId: null,
  });
  const second = openSession(db, {
    url: "http://localhost/threads/thr_abc?pane=1",
    route: "/threads/thr_abc",
    title: "bb",
    threadId: "thr_abc",
    projectId: null,
  });

  assert.equal(second.id, first.id);
  assert.equal(listSessions(db, {}).length, 1);
});

test("a different route gets its own session", () => {
  const db = freshDb();
  openSession(db, {
    url: "http://localhost/",
    route: "/",
    title: "bb",
    threadId: null,
    projectId: null,
  });
  openSession(db, {
    url: "http://localhost/plugins/github/issues",
    route: "/plugins/github/issues",
    title: "bb",
    threadId: null,
    projectId: null,
  });

  assert.equal(listSessions(db, {}).length, 2);
});

test("an annotation keeps the surface it was captured on across edits", () => {
  const db = freshDb();
  const session = openSession(db, {
    url: "http://localhost/plugins/github/issues",
    route: "/plugins/github/issues",
    title: "bb",
    threadId: null,
    projectId: null,
  });

  upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation(),
    bb: bbContext({
      route: "/plugins/github/issues",
      pluginId: "github",
      surface: "navPanel",
      threadId: null,
    }),
  });

  // An edit arrives from the comment box, where the last click was elsewhere.
  const edited = upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ comment: "Now says the wrong count" }),
    bb: bbContext({ pluginId: null, surface: null }),
  });

  assert.equal(edited.comment, "Now says the wrong count");
  assert.equal(edited.bb.pluginId, "github");
  assert.equal(edited.bb.surface, "navPanel");
});

test("an edit never rewinds a status the agent already advanced", () => {
  const db = freshDb();
  const { session, stored } = seed(db);

  setAnnotationStatus(db, {
    annotationId: stored.id,
    status: "acknowledged",
    by: "agent",
  });

  const edited = upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ comment: "clarified", status: "pending" }),
    bb: bbContext(),
  });

  assert.equal(edited.status, "acknowledged");
});

test("an edit keeps the reply thread", () => {
  const db = freshDb();
  const { session, stored } = seed(db);

  appendThreadMessage(db, stored.id, {
    role: "agent",
    content: "24px or 16px?",
  });
  const edited = upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ comment: "16px" }),
    bb: bbContext(),
  });

  assert.equal(edited.thread.length, 1);
  assert.equal(edited.thread[0]?.role, "agent");
});

test("replies persist their own accepted author snapshots separately", () => {
  const db = freshDb();
  const { stored } = seed(db, coleAuthor);
  const reply = appendThreadMessage(db, stored.id, {
    role: "human",
    content: "Please keep the current copy.",
    author: machineAuthor,
  });

  assert.deepEqual(reply?.author, coleAuthor);
  assert.deepEqual(reply?.thread[0]?.author, machineAuthor);
  assert.equal(reply?.thread[0]?.content, "Please keep the current copy.");
});

test("resolving records who closed it and when", () => {
  const db = freshDb();
  const { stored } = seed(db);

  const resolved = setAnnotationStatus(db, {
    annotationId: stored.id,
    status: "resolved",
    by: "agent",
    resolution: "clamped the label width",
  });

  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.resolvedBy, "agent");
  assert.ok(resolved?.resolvedAt);
  assert.equal(resolved?.resolution, "clamped the label width");
});

test("reopening clears the resolution timestamps", () => {
  const db = freshDb();
  const { stored } = seed(db);

  setAnnotationStatus(db, {
    annotationId: stored.id,
    status: "resolved",
    by: "agent",
  });
  const reopened = setAnnotationStatus(db, {
    annotationId: stored.id,
    status: "pending",
    by: "human",
  });

  assert.equal(reopened?.status, "pending");
  assert.equal(reopened?.resolvedAt, undefined);
  assert.equal(reopened?.resolvedBy, undefined);
});

test("status changes move the session cursor so clients notice", () => {
  const db = freshDb();
  const { session, stored } = seed(db);
  const before = sessionCursor(db, session.id);

  setAnnotationStatus(db, {
    annotationId: stored.id,
    status: "resolved",
    by: "agent",
  });

  assert.ok(sessionCursor(db, session.id) > before);
});

test("a delete moves the cursor even though its row is gone", () => {
  const db = freshDb();
  const { session, stored } = seed(db);
  const before = sessionCursor(db, session.id);

  assert.equal(deleteAnnotations(db, [stored.id]), 1);

  assert.equal(getAnnotation(db, stored.id), null);
  assert.ok(sessionCursor(db, session.id) > before);
});

test("clearing a session empties it and moves the cursor", () => {
  const db = freshDb();
  const { session } = seed(db);
  const before = sessionCursor(db, session.id);

  assert.equal(clearSession(db, session.id), 1);

  assert.equal(listAnnotations(db, { sessionId: session.id }).length, 0);
  assert.ok(sessionCursor(db, session.id) > before);
});

test("annotations filter by status, plugin, and cursor", () => {
  const db = freshDb();
  const session = openSession(db, {
    url: "http://localhost/",
    route: "/",
    title: "bb",
    threadId: null,
    projectId: null,
  });

  upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ id: "ann_shell" }),
    bb: bbContext({ route: "/", pluginId: null }),
  });
  const pluginAnnotation = upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ id: "ann_plugin" }),
    bb: bbContext({ route: "/", pluginId: "dotfiles" }),
  });
  setAnnotationStatus(db, {
    annotationId: "ann_shell",
    status: "resolved",
    by: "agent",
  });

  assert.deepEqual(
    listAnnotations(db, { statuses: ["pending"] }).map((item) => item.id),
    ["ann_plugin"],
  );
  assert.deepEqual(
    listAnnotations(db, { pluginId: "dotfiles" }).map((item) => item.id),
    ["ann_plugin"],
  );
  assert.deepEqual(
    listAnnotations(db, { sinceSeq: pluginAnnotation.seq }).map((item) => item.id),
    ["ann_shell"],
  );
});

test("toolbar session snapshots can read beyond the review cap", () => {
  const db = freshDb();
  const session = openSession(db, {
    url: "http://localhost/",
    route: "/",
    title: "bb",
    threadId: null,
    projectId: null,
  });

  db.transaction(() => {
    for (let index = 0; index < 501; index += 1) {
      upsertAnnotation(db, {
        sessionId: session.id,
        annotation: annotation({ id: `ann_${index}` }),
        bb: bbContext({ route: "/" }),
      });
    }
  })();

  assert.equal(listAnnotations(db, { sessionId: session.id }).length, 500);
  assert.equal(listAnnotations(db, { sessionId: session.id, limit: null }).length, 501);
});

test("counts report every status", () => {
  const db = freshDb();
  const { stored } = seed(db);
  setAnnotationStatus(db, {
    annotationId: stored.id,
    status: "dismissed",
    by: "agent",
    resolution: "by design",
  });

  const counts = countByStatus(db);
  assert.equal(counts.total, 1);
  assert.equal(counts.dismissed, 1);
  assert.equal(counts.pending, 0);
});

test("pruning drops only closed annotations past the retention window", () => {
  const db = freshDb();
  const { stored } = seed(db);
  setAnnotationStatus(db, {
    annotationId: stored.id,
    status: "resolved",
    by: "agent",
  });

  assert.equal(pruneClosed(db, 7), 0, "a fresh resolve stays");

  db.prepare(`UPDATE annotations SET updated_at = ? WHERE id = ?`).run(
    "2020-01-01T00:00:00.000Z",
    stored.id,
  );
  assert.equal(pruneClosed(db, 7), 1);
  assert.equal(countByStatus(db).total, 0);
});

test("unknown fields from a newer toolbar survive a round trip", () => {
  const db = freshDb();
  const session = openSession(db, {
    url: "http://localhost/",
    route: "/",
    title: "bb",
    threadId: null,
    projectId: null,
  });

  upsertAnnotation(db, {
    sessionId: session.id,
    annotation: annotation({ futureField: "keep me" } as Partial<Annotation>),
    bb: bbContext(),
  });

  const [read] = listAnnotations(db, { sessionId: session.id });
  assert.equal((read as Record<string, unknown>).futureField, "keep me");
});
