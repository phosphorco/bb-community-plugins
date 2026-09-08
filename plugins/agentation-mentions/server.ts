// Agentation → Mentions — based on Agentation by Scott Sunarto at 8bc27b91333e2228607b137d09b195d90e6aecfa.
//
// The browser toolbar is the only writer of annotation bodies; this backend is
// the durable store, the agent-facing surface, and the change bus that pushes
// agent decisions back to every open bb window.
//
// Wire surfaces, and why each exists:
//   rpc            the toolbar and composer attachment UI talk here
//   GET /events    server-sent events, so a resolve lands in the browser at once
//   agent tools    the loop an agent actually runs (pending → fix → resolve)
//   bb agentation-mentions  the same loop for agents that prefer a shell

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { bindBbIdentity } from "@phosphorco/bb-identity/bb";
import { z } from "zod";

import {
  type AnnotationStatus,
  type SessionStatus,
  annotationRoutingSchema,
  annotationSchema,
  annotationStatuses,
  bbContextSchema,
  sanitizeJson,
  sessionSchema,
  sessionSummarySchema,
  storedAnnotationSchema,
} from "./lib/afs.ts";
import { projectIdFromRoute, threadIdFromRoute } from "./lib/route.ts";
import {
  renderAnnotation,
  renderAnnotationAssignment,
  renderAnnotationLine,
  renderAnnotations,
} from "./lib/markdown.ts";
import {
  appendThreadMessage,
  clearSession,
  countByStatus,
  currentSeq,
  deleteAnnotations,
  getAnnotation,
  getSession,
  listAnnotations,
  listSessions,
  migrations,
  openSession,
  pruneClosed,
  sessionCursor,
  setAnnotationStatus,
  upsertAnnotation,
} from "./lib/store.ts";
import {
  claimStagedAnnotations,
  completeDispatch,
  discardStagedAnnotations,
  failDispatch,
  getAnnotationRouting,
  listAnnotationRoutings,
  listStagedAnnotations,
  recoverInterruptedDispatches,
  restageAnnotation as restageStoredAnnotation,
} from "./lib/staging.ts";
import {
  annotationAuthor,
  authorGroupKey,
  captureAnnotationAuthor,
  decodeCapturedAuthorMention,
  unavailableAnnotationAuthor,
  wrapAgentationContent,
  type AgentationPromptInput,
  type AuthorAttribution,
} from "./lib/identity.ts";
import {
  deliverAnnotationInput,
  type AnnotationDelivery,
} from "./lib/delivery.ts";
import {
  AGENTATION_MENTION_PROVIDER,
  CAPTURED_AUTHOR_MENTION_PROVIDER,
  decodeAgentationAttachment,
} from "./lib/attachment.ts";

const openStatuses: AnnotationStatus[] = ["pending", "acknowledged"];

const configSchema = z.object({
  toolbarEnabled: z.boolean(),
});

export const rpcContract = defineRpcContract({
  // --- toolbar content script -------------------------------------------
  openSession: {
    input: z
      .object({
        url: z.string(),
        route: z.string(),
        title: z.string().nullable(),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      session: sessionSchema,
      annotations: z.array(storedAnnotationSchema),
      cursor: z.number().int(),
      config: configSchema,
    }),
  },
  pushAnnotations: {
    input: z
      .object({
        sessionId: z.string(),
        upserts: z.array(
          z.object({
            annotation: annotationSchema,
            bb: bbContextSchema,
          }),
        ),
        deletedIds: z.array(z.string()),
      })
      .strict(),
    output: z.object({
      cursor: z.number().int(),
      annotations: z.array(storedAnnotationSchema),
    }),
  },
  pullSession: {
    input: z.object({ sessionId: z.string(), cursor: z.number().int() }).strict(),
    output: z.object({
      cursor: z.number().int(),
      changed: z.boolean(),
      annotations: z.array(storedAnnotationSchema),
      config: configSchema,
    }),
  },
  clearSessionAnnotations: {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ cursor: z.number().int(), removed: z.number().int() }),
  },
  listStagedAnnotations: {
    input: z.null(),
    output: z.object({ annotations: z.array(storedAnnotationSchema) }),
  },
  discardStagedAnnotations: {
    input: z.object({ annotationIds: z.array(z.string()).min(1) }).strict(),
    output: z.object({
      outcome: z.enum(["discarded", "stale"]),
      discardedIds: z.array(z.string()),
      remainingCount: z.number().int(),
      message: z.string(),
    }),
  },
  sendStagedAnnotations: {
    input: z
      .object({
        annotationIds: z.array(z.string()).min(1),
        threadId: z.string().min(1),
        delivery: z.enum(["send", "queue"]),
      })
      .strict(),
    output: z.object({
      outcome: z.enum(["sent", "queued", "stale"]),
      assignedIds: z.array(z.string()),
      remainingCount: z.number().int(),
      message: z.string(),
    }),
  },
  restageAnnotation: {
    input: z.object({ annotationId: z.string() }).strict(),
    output: z.object({ routing: annotationRoutingSchema.nullable() }),
  },

  // --- annotation management --------------------------------------------
  getConfig: {
    input: z.null(),
    output: z.object({
      config: configSchema,
      counts: z.object({
        pending: z.number().int(),
        acknowledged: z.number().int(),
        resolved: z.number().int(),
        dismissed: z.number().int(),
        total: z.number().int(),
      }),
    }),
  },
  setToolbarEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ toolbarEnabled: z.boolean() }),
  },
  listSessions: {
    input: z.object({ status: z.enum(["active"]).nullable() }).strict(),
    output: z.object({ sessions: z.array(sessionSummarySchema) }),
  },
  listAnnotations: {
    input: z
      .object({
        sessionId: z.string().nullable(),
        statuses: z.array(z.enum(annotationStatuses)).nullable(),
        pluginId: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      annotations: z.array(storedAnnotationSchema),
      routings: z.record(z.string(), annotationRoutingSchema),
    }),
  },
  mutateAnnotation: {
    input: z
      .object({
        annotationId: z.string(),
        action: z.enum(["acknowledge", "resolve", "dismiss", "reopen", "delete"]),
        note: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      annotation: storedAnnotationSchema.nullable(),
      deleted: z.boolean(),
    }),
  },
  replyToAnnotation: {
    input: z.object({ annotationId: z.string(), message: z.string().min(1) }).strict(),
    output: z.object({ annotation: storedAnnotationSchema.nullable() }),
  },
});

const { pushAnnotations, ...ordinaryRpcContract } = rpcContract;
const identityRpcContract = defineRpcContract({ pushAnnotations });

function groupByAuthor(
  annotations: readonly z.infer<typeof storedAnnotationSchema>[],
): Array<{
  author: AuthorAttribution;
  annotations: z.infer<typeof storedAnnotationSchema>[];
}> {
  const groups = new Map<
    string,
    { author: AuthorAttribution; annotations: z.infer<typeof storedAnnotationSchema>[] }
  >();
  for (const annotation of annotations) {
    const author = annotationAuthor(annotation);
    const key = authorGroupKey(author);
    const group = groups.get(key);
    if (group) group.annotations.push(annotation);
    else groups.set(key, { author, annotations: [annotation] });
  }
  return [...groups.values()];
}

export default async function plugin(bb: BbPluginApi) {
  const identityResult = bindBbIdentity(bb);
  if (!identityResult.ok) throw new Error(identityResult.error.message);
  const identity = identityResult.value;
  const settings = bb.settings.define({
    retentionDays: {
      type: "string",
      label: "Days to keep resolved annotations",
      default: "7",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const recoveredDispatches = recoverInterruptedDispatches(db);
  if (recoveredDispatches > 0) {
    bb.log.warn(`re-staged ${recoveredDispatches} annotations interrupted during delivery`);
  }

  // Whether the toolbar is showing is live state, not configuration: it is
  // toggled from the CLI mid-session, and plugin settings are
  // read-only from a handler. So it lives in kv, where a handler can write it.
  const TOOLBAR_KEY = "toolbar-enabled";

  async function isToolbarEnabled(): Promise<boolean> {
    return (await bb.storage.kv.get<boolean>(TOOLBAR_KEY)) ?? true;
  }

  async function readConfig(): Promise<z.infer<typeof configSchema>> {
    return {
      toolbarEnabled: await isToolbarEnabled(),
    };
  }

  // -------------------------------------------------------------------------
  // Change bus
  //
  // Three consumers care about a write: composer integrations (bb realtime),
  // every open toolbar (server-sent events), and any agent parked in
  // `agentation_mentions_watch_annotations`.
  // -------------------------------------------------------------------------

  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const heartbeats = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    ReturnType<typeof setInterval>
  >();
  const watchers = new Set<() => void>();
  const encoder = new TextEncoder();
  let disposed = false;

  function broadcast(event: { type: string; sessionId: string | null }): void {
    const payload = {
      ...event,
      cursor: currentSeq(db),
      at: new Date().toISOString(),
    };

    bb.realtime.publish("annotations", payload);

    const frame = encoder.encode(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
    // Both loops may delete the entry they are standing on — well defined for
    // a Set, and nothing here removes any other entry.
    for (const controller of streams) {
      try {
        controller.enqueue(frame);
      } catch {
        dropStream(controller);
      }
    }

    for (const wake of watchers) wake();
  }

  function dropStream(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const heartbeat = heartbeats.get(controller);
    if (heartbeat) clearInterval(heartbeat);
    heartbeats.delete(controller);
    streams.delete(controller);
  }

  bb.ui.registerMentionProvider({
    id: AGENTATION_MENTION_PROVIDER,
    label: "Agentation → Mentions feedback",
    search: () => [],
    async resolve(itemId) {
      const attachment = decodeAgentationAttachment(itemId);
      const annotations = attachment.annotationIds.map((annotationId) => {
        const annotation = getAnnotation(db, annotationId);
        if (!annotation || !openStatuses.includes(annotation.status)) {
          throw new Error(
            "Attached Agentation feedback was deleted or closed. Remove this attachment and add the current annotations again.",
          );
        }
        return annotation;
      });
      const sessions = listSessions(db, {});
      const sections: string[] = [];
      for (const group of groupByAuthor(annotations)) {
        const markdown = renderAnnotations(group.annotations, {
          title: "bb UI feedback from Agentation",
          sessions,
        });
        sections.push(
          wrapAgentationContent(markdown, group.author, bb.pluginId)
            .map((part) => part.text)
            .join(""),
        );
      }

      return {
        context: `${sections.join("\n\n")}\n\nResolve each item with the \`agentation_mentions_resolve\` tool once it is fixed.`,
      };
    },
  });

  bb.ui.registerMentionProvider({
    id: CAPTURED_AUTHOR_MENTION_PROVIDER,
    label: "Captured feedback author",
    search: () => [],
    resolve(itemId) {
      const author = decodeCapturedAuthorMention(itemId);
      return {
        context: `Captured feedback author: ${author.presentation.displayName}. This is historical source evidence captured at ${author.capturedAt}, not a live authenticated request.`,
      };
    },
  });

  // Responses are built through the Hono context rather than `new Response`:
  // the host checks `instanceof Response` against its own realm, and only the
  // context's constructor is guaranteed to be the same one.
  bb.http.route("GET", "/events", (c) => {
    let self: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        streams.add(controller);
        controller.enqueue(
          encoder.encode(`event: hello\ndata: ${JSON.stringify({ cursor: currentSeq(db) })}\n\n`),
        );
        // An idle stream gets dropped by proxies and by the tunnel used for
        // remote bb access; a comment frame is the cheapest thing that keeps
        // it open and costs the client nothing to parse.
        heartbeats.set(
          controller,
          setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {
              dropStream(controller);
            }
          }, 25_000),
        );
      },
      cancel() {
        if (self) dropStream(self);
      },
    });

    return c.newResponse(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  bb.http.route("GET", "/health", (c) =>
    c.json({
      ok: true,
      pluginId: bb.pluginId,
      cursor: currentSeq(db),
      counts: countByStatus(db),
    }),
  );

  // -------------------------------------------------------------------------
  // Thread delivery
  // -------------------------------------------------------------------------

  async function sendStagedToThread(
    annotationIds: string[],
    threadId: string,
    delivery: AnnotationDelivery,
  ): Promise<{
    outcome: "sent" | "queued" | "stale";
    assignedIds: string[];
    remainingCount: number;
    message: string;
  }> {
    const claim = claimStagedAnnotations(db, { annotationIds, threadId });
    if (claim.outcome === "stale") {
      const remainingCount = listStagedAnnotations(db).length;
      return {
        outcome: "stale",
        assignedIds: [],
        remainingCount,
        message: "The staged annotations changed. Review the current batch and send it again.",
      };
    }

    broadcast({ type: "routing", sessionId: null });

    const sessions = listSessions(db, {});
    const input: AgentationPromptInput[] = [];
    for (const group of groupByAuthor(claim.dispatch.annotations)) {
      const markdown = renderAnnotations(group.annotations, {
        title: "bb UI feedback from Agentation",
        sessions,
      });
      input.push(...wrapAgentationContent(markdown, group.author, bb.pluginId));
    }
    input.push({
      type: "text",
      text: "\n\nResolve each item with the `agentation_mentions_resolve` tool once it is fixed, or `agentation_mentions_reply` if you need a decision from me.",
      mentions: [],
      visibility: "agent-only",
    });

    try {
      await deliverAnnotationInput(bb.sdk.threads, threadId, input, delivery);

      completeDispatch(db, claim.dispatch.id);
      broadcast({ type: "routing", sessionId: null });
      bb.log.info(
        `${delivery === "queue" ? "queued" : "sent"} ${claim.dispatch.annotations.length} staged annotations for ${threadId}`,
      );

      const count = claim.dispatch.annotations.length;
      return {
        outcome: delivery === "queue" ? "queued" : "sent",
        assignedIds: claim.dispatch.annotations.map((annotation) => annotation.id),
        remainingCount: listStagedAnnotations(db).length,
        message:
          delivery === "queue"
            ? `Queued ${count} annotation${count === 1 ? "" : "s"} in this thread.`
            : `Sent ${count} annotation${count === 1 ? "" : "s"} to this thread.`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failDispatch(db, claim.dispatch.id, detail);
      broadcast({ type: "routing", sessionId: null });
      bb.log.warn(`delivery to ${threadId} failed: ${detail}`);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // rpc
  // -------------------------------------------------------------------------

  const identityRpc = identity.rpc.register(identityRpcContract, {
    pushAnnotations: {
      origin: "interactive-user",
      async handle(input, invocation) {
        if (!getSession(db, input.sessionId)) {
          throw new Error(`unknown session ${input.sessionId}`);
        }
        const session = await identity.server.session(invocation);
        const author = session.status === "ready"
          ? captureAnnotationAuthor(session.actor)
          : unavailableAnnotationAuthor(session.status);
        for (const item of input.upserts) {
          upsertAnnotation(db, {
            sessionId: input.sessionId,
            annotation: item.annotation,
            bb: item.bb,
            author,
          });
        }
        if (input.deletedIds.length > 0) deleteAnnotations(db, input.deletedIds);
        if (input.upserts.length > 0 || input.deletedIds.length > 0) {
          broadcast({ type: "annotations", sessionId: input.sessionId });
        }
        return sanitizeJson({
          cursor: sessionCursor(db, input.sessionId),
          annotations: listAnnotations(db, { sessionId: input.sessionId, limit: null }),
        });
      },
    },
  });
  if (!identityRpc.ok) {
    identity.dispose();
    throw new Error(identityRpc.error.message);
  }

  bb.rpc.register(ordinaryRpcContract, {
    async openSession(input) {
      const session = openSession(db, {
        url: input.url,
        route: input.route,
        title: input.title,
        threadId: input.threadId ?? threadIdFromRoute(input.route),
        projectId: input.projectId ?? projectIdFromRoute(input.route),
      });
      return sanitizeJson({
        session,
        annotations: listAnnotations(db, {
          sessionId: session.id,
          limit: null,
        }),
        cursor: sessionCursor(db, session.id),
        config: await readConfig(),
      });
    },

    async pullSession(input) {
      const cursor = sessionCursor(db, input.sessionId);
      return sanitizeJson({
        cursor,
        changed: cursor > input.cursor,
        annotations: listAnnotations(db, {
          sessionId: input.sessionId,
          limit: null,
        }),
        config: await readConfig(),
      });
    },

    clearSessionAnnotations(input) {
      const removed = clearSession(db, input.sessionId);
      broadcast({ type: "annotations", sessionId: input.sessionId });
      return { cursor: sessionCursor(db, input.sessionId), removed };
    },

    listStagedAnnotations() {
      return sanitizeJson({ annotations: listStagedAnnotations(db) });
    },

    discardStagedAnnotations(input) {
      const result = discardStagedAnnotations(db, input.annotationIds);
      const remainingCount = listStagedAnnotations(db).length;
      if (result.outcome === "stale") {
        return {
          outcome: "stale" as const,
          discardedIds: [],
          remainingCount,
          message: "The staged annotations changed. Review the current batch and discard it again.",
        };
      }

      broadcast({ type: "annotations", sessionId: null });

      const discardedIds = result.annotations.map((annotation) => annotation.id);
      return {
        outcome: "discarded" as const,
        discardedIds,
        remainingCount,
        message: `Discarded ${discardedIds.length} annotation${discardedIds.length === 1 ? "" : "s"}.`,
      };
    },

    async sendStagedAnnotations(input) {
      return sanitizeJson(
        await sendStagedToThread(
          input.annotationIds,
          input.threadId,
          input.delivery,
        ),
      );
    },

    restageAnnotation(input) {
      const routing = restageStoredAnnotation(db, input.annotationId);
      if (routing) broadcast({ type: "routing", sessionId: null });
      return sanitizeJson({ routing });
    },

    async getConfig() {
      return { config: await readConfig(), counts: countByStatus(db) };
    },

    async setToolbarEnabled(input) {
      await bb.storage.kv.set(TOOLBAR_KEY, input.enabled);
      broadcast({ type: "config", sessionId: null });
      return { toolbarEnabled: input.enabled };
    },

    listSessions(input) {
      return sanitizeJson({
        sessions: listSessions(db, {
          status: (input.status as SessionStatus | null) ?? undefined,
        }),
      });
    },

    listAnnotations(input) {
      const annotations = listAnnotations(db, {
        sessionId: input.sessionId ?? undefined,
        statuses: input.statuses ?? undefined,
        pluginId: input.pluginId ?? undefined,
      });

      return sanitizeJson({
        annotations,
        routings: listAnnotationRoutings(
          db,
          annotations.map((annotation) => annotation.id),
        ),
      });
    },

    mutateAnnotation(input) {
      if (input.action === "delete") {
        const existing = getAnnotation(db, input.annotationId);
        deleteAnnotations(db, [input.annotationId]);
        broadcast({
          type: "annotations",
          sessionId: existing?.sessionId ?? null,
        });
        return { annotation: null, deleted: existing !== null };
      }

      const status: AnnotationStatus =
        input.action === "acknowledge"
          ? "acknowledged"
          : input.action === "resolve"
            ? "resolved"
            : input.action === "dismiss"
              ? "dismissed"
              : "pending";

      const annotation = setAnnotationStatus(db, {
        annotationId: input.annotationId,
        status,
        by: "human",
        resolution: input.note,
      });
      if (annotation) {
        broadcast({ type: "annotations", sessionId: annotation.sessionId });
      }
      return sanitizeJson({ annotation, deleted: false });
    },

    async replyToAnnotation(input) {
      const existing = getAnnotation(db, input.annotationId);
      if (!existing) return sanitizeJson({ annotation: null });

      const routing = getAnnotationRouting(db, input.annotationId);
      if (routing?.state !== "assigned" || !routing.assignedThreadId) {
        throw new Error("Stage and send this annotation to a thread before you reply.");
      }

      const context = renderAnnotation(existing);
      await bb.sdk.threads.send({
        threadId: routing.assignedThreadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: `# Agentation follow-up\n\n${context}\n\n## Human reply\n\n${input.message}`,
            mentions: [],
          },
        ],
      });

      const annotation = appendThreadMessage(db, input.annotationId, {
        role: "human",
        content: input.message,
      });
      if (annotation) {
        broadcast({ type: "annotations", sessionId: annotation.sessionId });
      }
      return sanitizeJson({ annotation });
    },
  });

  // -------------------------------------------------------------------------
  // Agent tools
  //
  // Names mirror the upstream agentation MCP server, so prompts and skills
  // written for it work unchanged against a bb thread — with no MCP process to
  // configure, because bb hands these to whichever provider the thread runs.
  // -------------------------------------------------------------------------

  function toolText(text: string): string {
    return text;
  }

  bb.agents.registerTool({
    name: "agentation_mentions_list_sessions",
    description:
      "List annotation sessions — one per bb page a human has left visual feedback on. Start here to discover which pages have feedback.",
    presentation: { label: {
      pending: "Listing annotation sessions",
      completed: "Listed annotation sessions",
    } },
    parameters: z.object({}),
    execute() {
      const sessions = listSessions(db, {});
      if (sessions.length === 0) return toolText("No annotation sessions yet.");
      return toolText(
        sessions
          .map(
            (session) =>
              `${session.id}  ${session.route}  pending=${session.counts.pending} acknowledged=${session.counts.acknowledged} resolved=${session.counts.resolved}`,
          )
          .join("\n"),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_get_session",
    description:
      "Get one annotation session with every annotation on it, including resolved and dismissed ones.",
    presentation: { label: {
      pending: "Reading annotation session",
      completed: "Read annotation session",
    } },
    parameters: z.object({ sessionId: z.string() }),
    execute({ sessionId }) {
      const session = getSession(db, sessionId);
      if (!session) return toolText(`No session ${sessionId}.`);
      return toolText(
        renderAnnotations(listAnnotations(db, { sessionId }), {
          title: `Session ${sessionId}`,
          sessions: [session],
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_get_pending",
    description:
      "Get the open (pending or acknowledged) annotations for one session, rendered with the bb route, owning plugin, and DOM selector for each.",
    presentation: { label: {
      pending: "Reading pending annotations",
      completed: "Read pending annotations",
    } },
    parameters: z.object({ sessionId: z.string() }),
    execute({ sessionId }) {
      const session = getSession(db, sessionId);
      return toolText(
        renderAnnotations(listAnnotations(db, { sessionId, statuses: openStatuses }), {
          title: `Open annotations in ${sessionId}`,
          sessions: session ? [session] : [],
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_get_all_pending",
    description:
      "Get every open annotation across all bb pages. Use this when the human refers to UI feedback but did not supply a self-contained Agentation annotation batch.",
    instructions:
      "When the human refers to feedback they left on the bb interface and their message does not already contain an Agentation annotation batch, read it with agentation_mentions_get_all_pending before searching the code. A supplied batch is self-contained; do not fetch other pending feedback. Each annotation names the bb route and, for plugin surfaces, the owning plugin id.",
    presentation: { label: {
      pending: "Reading all pending annotations",
      completed: "Read all pending annotations",
    } },
    parameters: z.object({
      pluginId: z.string().optional().describe("Only annotations on this plugin's UI surfaces."),
    }),
    execute({ pluginId }) {
      return toolText(
        renderAnnotations(listAnnotations(db, { statuses: openStatuses, pluginId }), {
          title: "Open bb UI feedback",
          sessions: listSessions(db, {}),
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_acknowledge",
    description: "Mark an annotation as acknowledged so the human can see you have picked it up.",
    presentation: { label: {
      pending: "Acknowledging annotation",
      completed: "Acknowledged annotation",
    } },
    parameters: z.object({ annotationId: z.string() }),
    execute({ annotationId }) {
      const annotation = setAnnotationStatus(db, {
        annotationId,
        status: "acknowledged",
        by: "agent",
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Acknowledged ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_resolve",
    description:
      "Mark an annotation as resolved after you have fixed it. The marker disappears from the human's toolbar. Include a short summary of what changed.",
    presentation: { label: {
      pending: "Resolving annotation",
      completed: "Resolved annotation",
    } },
    parameters: z.object({
      annotationId: z.string(),
      summary: z.string().optional(),
    }),
    execute({ annotationId, summary }) {
      const annotation = setAnnotationStatus(db, {
        annotationId,
        status: "resolved",
        by: "agent",
        resolution: summary ?? null,
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Resolved ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_dismiss",
    description:
      "Dismiss an annotation you have decided not to act on. A reason is required — the human sees it.",
    presentation: { label: {
      pending: "Dismissing annotation",
      completed: "Dismissed annotation",
    } },
    parameters: z.object({ annotationId: z.string(), reason: z.string() }),
    execute({ annotationId, reason }) {
      const annotation = setAnnotationStatus(db, {
        annotationId,
        status: "dismissed",
        by: "agent",
        resolution: reason,
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Dismissed ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_reply",
    description:
      "Add a message to an annotation's thread — ask a clarifying question, or report progress. The human reads and answers it in the Agentation annotator UI.",
    presentation: { label: {
      pending: "Replying to annotation",
      completed: "Replied to annotation",
    } },
    parameters: z.object({ annotationId: z.string(), message: z.string() }),
    execute({ annotationId, message }) {
      const annotation = appendThreadMessage(db, annotationId, {
        role: "agent",
        content: message,
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Replied on ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_mentions_watch_annotations",
    description:
      "Block until new annotations appear, then return the batch. Call it in a loop for hands-free feedback: watch, fix, resolve, watch again.",
    presentation: { label: {
      pending: "Watching for new annotations",
      completed: "Collected new annotations",
    } },
    parameters: z.object({
      sessionId: z.string().optional().describe("Only watch one page's session."),
      batchWindowSeconds: z
        .number()
        .int()
        .min(0)
        .max(60)
        .optional()
        .describe("After the first new annotation, keep collecting for this long. Default 10."),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe("Give up after this long with nothing new. Default 120."),
    }),
    async execute({ sessionId, batchWindowSeconds, timeoutSeconds }, context) {
      const batchWindowMs = (batchWindowSeconds ?? 10) * 1000;
      const timeoutMs = (timeoutSeconds ?? 120) * 1000;
      const startCursor = currentSeq(db);

      const fresh = () =>
        listAnnotations(db, {
          sessionId,
          statuses: openStatuses,
          sinceSeq: startCursor,
        });

      const appeared = await waitForChange(timeoutMs, context.signal, () => fresh().length > 0);
      if (!appeared) {
        return toolText(
          "No new annotations before the timeout. Call agentation_mentions_watch_annotations again to keep waiting.",
        );
      }

      if (batchWindowMs > 0) {
        await sleep(batchWindowMs, context.signal);
      }

      const batch = fresh();
      return toolText(
        renderAnnotations(batch, {
          title: `${batch.length} new annotation${batch.length === 1 ? "" : "s"}`,
          sessions: listSessions(db, {}),
        }),
      );
    },
  });

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Resolve true as soon as `test()` passes, false on timeout or abort. */
  function waitForChange(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    test: () => boolean,
  ): Promise<boolean> {
    if (test()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watchers.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const wake = () => {
        if (test()) finish(true);
      };
      const onAbort = () => finish(false);

      const timer = setTimeout(() => finish(false), timeoutMs);
      watchers.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (disposed) finish(false);
    });
  }

  bb.agents.contributeInstructions(() => {
    try {
      const pending = countByStatus(db).pending;
      if (pending === 0) return null;
      return `The human has ${pending} unresolved Agentation annotation${pending === 1 ? "" : "s"} on the bb interface. Before acting on a request about the bb UI, call agentation_mentions_get_all_pending only when the request does not already contain an Agentation annotation batch. A supplied batch is self-contained; work only on its listed annotation IDs. Resolve each annotation you fix.`;
    } catch {
      return null;
    }
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  bb.cli.register({
    name: "agentation-mentions",
    summary: "Read and resolve visual feedback left on the bb interface",
    commands: [
      {
        name: "pending",
        summary: "Show every open annotation",
        usage: "bb agentation-mentions pending [--plugin <id>] [--json]",
      },
      {
        name: "staged",
        summary: "Show annotations waiting for a thread",
        usage: "bb agentation-mentions staged [--json]",
      },
      {
        name: "send",
        summary: "Assign staged annotations to a thread now or queue them",
        usage: "bb agentation-mentions send [--queue] <threadId> [annotationId…]",
      },
      {
        name: "restage",
        summary: "Return an assigned annotation to staging",
        usage: "bb agentation-mentions restage <annotationId>",
      },
      {
        name: "sessions",
        summary: "List annotated pages",
        usage: "bb agentation-mentions sessions",
      },
      {
        name: "show",
        summary: "Show one annotation in full",
        usage: "bb agentation-mentions show <annotationId>",
      },
      {
        name: "acknowledge",
        summary: "Mark an annotation as seen",
        usage: "bb agentation-mentions acknowledge <annotationId>",
      },
      {
        name: "resolve",
        summary: "Mark an annotation as fixed",
        usage: "bb agentation-mentions resolve <annotationId> [summary…]",
      },
      {
        name: "dismiss",
        summary: "Decline an annotation, with a reason",
        usage: "bb agentation-mentions dismiss <annotationId> <reason…>",
      },
      {
        name: "reply",
        summary: "Ask the human a question on an annotation",
        usage: "bb agentation-mentions reply <annotationId> <message…>",
      },
      {
        name: "toolbar",
        summary: "Show or set whether the annotation toolbar is displayed",
        usage: "bb agentation-mentions toolbar [on|off]",
      },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      const flagIndex = rest.indexOf("--plugin");
      const pluginId = flagIndex >= 0 ? (rest[flagIndex + 1] ?? undefined) : undefined;
      const json = rest.includes("--json");
      const positional = rest.filter(
        (value, index) => !value.startsWith("--") && !(flagIndex >= 0 && index === flagIndex + 1),
      );

      const ok = (stdout: string) => ({ exitCode: 0, stdout });
      const fail = (stderr: string) => ({ exitCode: 1, stderr });

      switch (command) {
        case undefined:
        case "help":
          return ok(
            [
              "bb agentation-mentions pending [--plugin <id>] [--json]",
              "bb agentation-mentions staged [--json]",
              "bb agentation-mentions send [--queue] <threadId> [annotationId…]",
              "bb agentation-mentions restage <annotationId>",
              "bb agentation-mentions sessions",
              "bb agentation-mentions show <annotationId>",
              "bb agentation-mentions acknowledge <annotationId>",
              "bb agentation-mentions resolve <annotationId> [summary…]",
              "bb agentation-mentions dismiss <annotationId> <reason…>",
              "bb agentation-mentions reply <annotationId> <message…>",
              "bb agentation-mentions toolbar [on|off]",
            ].join("\n"),
          );

        case "toolbar": {
          const desired = positional[0];
          if (desired === undefined) {
            return ok((await isToolbarEnabled()) ? "on" : "off");
          }
          if (desired !== "on" && desired !== "off") {
            return fail("usage: bb agentation-mentions toolbar [on|off]");
          }
          await bb.storage.kv.set(TOOLBAR_KEY, desired === "on");
          broadcast({ type: "config", sessionId: null });
          return ok(`toolbar ${desired}`);
        }

        case "pending": {
          const annotations = listAnnotations(db, {
            statuses: openStatuses,
            pluginId,
          });
          if (json) return ok(JSON.stringify(annotations, null, 2));
          if (annotations.length === 0) return ok("No open annotations.");
          return ok(annotations.map(renderAnnotationLine).join("\n"));
        }

        case "staged": {
          const annotations = listStagedAnnotations(db);
          if (json) return ok(JSON.stringify(annotations, null, 2));
          if (annotations.length === 0) return ok("No staged annotations.");
          return ok(annotations.map(renderAnnotationLine).join("\n"));
        }

        case "send": {
          const threadId = positional[0];
          if (!threadId) {
            return fail(
              "usage: bb agentation-mentions send [--queue] <threadId> [annotationId…]",
            );
          }
          const requestedIds = positional.slice(1);
          const annotationIds =
            requestedIds.length > 0
              ? requestedIds
              : listStagedAnnotations(db).map((annotation) => annotation.id);
          if (annotationIds.length === 0) return ok("No staged annotations.");

          const result = await sendStagedToThread(
            annotationIds,
            threadId,
            rest.includes("--queue") ? "queue" : "send",
          );
          return result.outcome === "sent" || result.outcome === "queued"
            ? ok(result.message)
            : fail(result.message);
        }

        case "restage": {
          const id = positional[0];
          if (!id) return fail("usage: bb agentation-mentions restage <annotationId>");
          const routing = restageStoredAnnotation(db, id);
          if (!routing) {
            return fail(`Annotation ${id} is not an assigned open annotation.`);
          }
          broadcast({ type: "routing", sessionId: null });
          return ok(`staged ${id}`);
        }

        case "sessions": {
          const sessions = listSessions(db, {});
          if (sessions.length === 0) return ok("No annotated pages yet.");
          return ok(
            sessions
              .map(
                (session) =>
                  `${session.id}  ${session.route.padEnd(40)} pending=${session.counts.pending} total=${session.counts.total}`,
              )
              .join("\n"),
          );
        }

        case "show": {
          const id = positional[0];
          if (!id) return fail("usage: bb agentation-mentions show <annotationId>");
          const annotation = getAnnotation(db, id);
          if (!annotation) return fail(`No annotation ${id}.`);
          return ok(renderAnnotation(annotation));
        }

        case "acknowledge":
        case "resolve":
        case "dismiss": {
          const id = positional[0];
          if (!id) return fail(`usage: bb agentation-mentions ${command} <annotationId>`);
          const note = positional.slice(1).join(" ") || null;
          if (command === "dismiss" && !note) {
            return fail("usage: bb agentation-mentions dismiss <annotationId> <reason…>");
          }
          const status: AnnotationStatus =
            command === "acknowledge"
              ? "acknowledged"
              : command === "resolve"
                ? "resolved"
                : "dismissed";
          const annotation = setAnnotationStatus(db, {
            annotationId: id,
            status,
            by: "agent",
            resolution: note,
          });
          if (!annotation) return fail(`No annotation ${id}.`);
          broadcast({ type: "annotations", sessionId: annotation.sessionId });
          return ok(`${status} ${id}`);
        }

        case "reply": {
          const id = positional[0];
          const message = positional.slice(1).join(" ");
          if (!id || !message) {
            return fail("usage: bb agentation-mentions reply <annotationId> <message…>");
          }
          const annotation = appendThreadMessage(db, id, {
            role: "agent",
            content: message,
          });
          if (!annotation) return fail(`No annotation ${id}.`);
          broadcast({ type: "annotations", sessionId: annotation.sessionId });
          return ok(`Replied on ${id}.`);
        }

        default:
          return fail(`Unknown command "${command}". Run \`bb agentation-mentions help\`.`);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  bb.background.schedule("prune", "17 4 * * *", async () => {
    const values = await settings.get();
    const days = Number.parseInt(values.retentionDays, 10);
    const removed = pruneClosed(db, Number.isFinite(days) ? days : 7);
    if (removed > 0) bb.log.info(`pruned ${removed} closed annotations`);
  });

  settings.onChange(() => {
    broadcast({ type: "config", sessionId: null });
  });

  bb.onDispose(() => {
    identity.dispose();
    disposed = true;
    for (const timer of heartbeats.values()) clearInterval(timer);
    heartbeats.clear();
    for (const controller of streams) {
      try {
        controller.close();
      } catch {
        // The client may already be gone; nothing to clean up.
      }
    }
    streams.clear();
    for (const wake of watchers) wake();
    watchers.clear();
  });

  bb.log.info(`ready — ${countByStatus(db).pending} pending annotations`);
}
