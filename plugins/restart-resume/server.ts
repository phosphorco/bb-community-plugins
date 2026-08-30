import type { BbPluginApi } from "@bb/plugin-sdk";

import {
  hasEventsAfter,
  hasInterruptedTurn,
  hasResumeRequestAfter,
  hostDaemonErrorAt as hostDaemonErrorTimestamp,
  isWithinRecoveryWindow,
  isRecoverableThread,
  latestHostRestartInterruption,
  resumeMessageFor,
  type RecoveryEvent,
} from "./recovery.ts";
import { rpcContract, type RestartResumeOutcome } from "./rpc-contract.ts";
import {
  RestartResumeStore,
  restartResumeMigrations,
} from "./store.ts";

const automaticSettings = {
  automatic: {
    type: "boolean" as const,
    label: "Resume threads interrupted by a host restart automatically",
    description:
      "When enabled, a thread left in an error state by a host daemon restart is resumed once.",
    default: true,
  },
};

const RETRY_INTERVAL_MS = 30_000;
const CLAIM_RENEW_INTERVAL_MS = 20_000;
const THREAD_PAGE_SIZE = 100;
// The public thread-list API has no activity-order parameter. Read its pages,
// then bound event inspection to the most recently updated error threads.
const RECENT_THREAD_LIMIT = 200;

interface RecoveryThreadShape {
  id: string;
  projectId: string;
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
  updatedAt: number;
}

interface RecoveryCandidate {
  events: RecoveryEvent[];
  interruption: RecoveryEvent;
  interruptedTurn: boolean;
  hostDaemonErrorAt: number | null;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default function restartResumePlugin(bb: BbPluginApi) {
  const settings = bb.settings.define(automaticSettings);
  const db = bb.storage.database();
  bb.storage.migrate(db, [...restartResumeMigrations]);
  const store = new RestartResumeStore(db);
  const activeSends = new Set<string>();

  const publishChange = (payload: unknown) => {
    bb.realtime.publish("restart-resume", payload);
  };

  settings.onChange(() => publishChange({ scope: "settings" }));

  const automaticEnabled = async (): Promise<boolean> =>
    (await settings.get()).automatic;

  const candidateFor = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<RecoveryCandidate | null> => {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: "100",
      signal,
    });
    const events = rows;
    const interruption = latestHostRestartInterruption(events);
    return interruption === null
      ? null
      : {
          events,
          interruption,
          interruptedTurn: hasInterruptedTurn(events, interruption.seq),
          hostDaemonErrorAt: hostDaemonErrorTimestamp(events, interruption.seq),
        };
  };

  const projectList = async () => {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const messages = new Map(
      store.listProjectMessages().map((entry) => [entry.projectId, entry.message]),
    );
    return projects
      .map((project) => ({
        id: project.id,
        name: project.name,
        message: messages.get(project.id) ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  };

  const projectResponse = async (projectId: string) => {
    const project = (await projectList()).find((entry) => entry.id === projectId);
    if (project === undefined) throw new Error(`Project not found: ${projectId}`);
    return project;
  };

  const resumeThread = async (
    threadId: string,
    options: {
      force?: boolean;
      recoveryAnchorAt?: number;
      signal?: AbortSignal;
      expectedInterruptionSeq?: number;
    } = {},
  ): Promise<RestartResumeOutcome> => {
    if (!options.force && !(await automaticEnabled())) {
      return {
        outcome: "not-eligible",
        detail: "Automatic restart resume is disabled in plugin settings.",
      };
    }

    let thread: RecoveryThreadShape;
    let candidate: RecoveryCandidate | null;
    try {
      thread = (await bb.sdk.threads.get({ threadId, signal: options.signal })) as RecoveryThreadShape;
      candidate = await candidateFor(threadId, options.signal);
    } catch (cause) {
      const detail = `Could not inspect thread ${threadId}: ${errorText(cause)}`;
      bb.log.warn(detail);
      return { outcome: "failed", detail };
    }

    if (candidate === null) {
      return {
        outcome: "not-interrupted",
        detail: "The latest thread event is not a host-daemon restart interruption.",
      };
    }

    if (
      options.expectedInterruptionSeq !== undefined &&
      candidate.interruption.seq !== options.expectedInterruptionSeq
    ) {
      return {
        outcome: "not-interrupted",
        detail: "The restart interruption changed while recovery was being reconciled.",
      };
    }
    if (
      options.recoveryAnchorAt !== undefined &&
      (candidate.interruption.createdAt === undefined ||
        !isWithinRecoveryWindow(candidate.interruption.createdAt, options.recoveryAnchorAt))
    ) {
      return {
        outcome: "not-interrupted",
        detail: "The host-daemon interruption is outside the current restart recovery window.",
      };
    }

    const message = resumeMessageFor(
      store.getProjectMessage(thread.projectId),
      candidate.interruptedTurn,
    );
    const existing = store.getAttempt(threadId, candidate.interruption.seq);
    if (existing?.status === "sent" || existing?.status === "skipped") {
      return {
        outcome: "already-handled",
        detail: "This restart interruption has already been handled.",
      };
    }

    // If the host accepted the send and the plugin process died before it
    // could mark the row sent, the durable request event prevents a duplicate.
    if (
      existing?.status === "pending" &&
      hasResumeRequestAfter(candidate.events, candidate.interruption.seq, message)
    ) {
      store.recordSent(
        threadId,
        candidate.interruption.seq,
        candidate.interruption.createdAt ?? Date.now(),
        Date.now(),
      );
      publishChange({ scope: "thread", threadId, outcome: "already-handled" });
      return {
        outcome: "already-handled",
        detail: "A matching restart-resume request is already in the thread event log.",
      };
    }

    if (hasEventsAfter(candidate.events, candidate.interruption.seq)) {
      store.markSkipped(
        threadId,
        candidate.interruption.seq,
        candidate.interruption.createdAt ?? Date.now(),
        Date.now(),
      );
      return {
        outcome: "not-interrupted",
        detail: "The thread has events after the host-daemon restart interruption.",
      };
    }

    if (!isRecoverableThread(thread)) {
      store.markSkipped(
        threadId,
        candidate.interruption.seq,
        candidate.interruption.createdAt ?? Date.now(),
        Date.now(),
      );
      return {
        outcome: "not-eligible",
        detail: `Thread status is ${thread.status}; only unarchived error threads are resumed.`,
      };
    }

    const recoveryKey = `${threadId}:${candidate.interruption.seq}`;
    if (activeSends.has(recoveryKey)) {
      return {
        outcome: "already-handled",
        detail: "Another restart-resume worker is already handling this interruption.",
      };
    }

    const now = Date.now();
    const leaseToken = store.claim(
      threadId,
      candidate.interruption.seq,
      candidate.interruption.createdAt ?? now,
      now,
    );
    if (leaseToken === null) {
      return {
        outcome: "already-handled",
        detail: "Another restart-resume worker is already handling this interruption.",
      };
    }
    activeSends.add(recoveryKey);
    const leaseRenewal = setInterval(() => {
      try {
        if (!store.renewLease(threadId, candidate.interruption.seq, leaseToken, Date.now())) {
          bb.log.warn(`Restart-resume lease lost for ${threadId}.`);
        }
      } catch (cause) {
        bb.log.warn(`Restart-resume lease renewal failed for ${threadId}: ${errorText(cause)}`);
      }
    }, CLAIM_RENEW_INTERVAL_MS);

    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "start",
        input: [{ type: "text", text: message, mentions: [] }],
      });
      if (!store.markSent(threadId, candidate.interruption.seq, leaseToken, Date.now())) {
        bb.log.warn(`Restart-resume send completed after its lease was fenced for ${threadId}.`);
      }
      publishChange({ scope: "thread", threadId, outcome: "sent" });
      bb.log.info(`Resumed thread ${threadId} after a host daemon restart.`);
      return {
        outcome: "sent",
        detail: "Restart-resume message sent; the thread will continue from its durable state.",
      };
    } catch (cause) {
      const detail = `Could not resume thread ${threadId}: ${errorText(cause)}`;
      store.markRetry(threadId, candidate.interruption.seq, leaseToken, detail, Date.now());
      bb.log.warn(detail);
      publishChange({ scope: "thread", threadId, outcome: "failed" });
      return { outcome: "failed", detail };
    } finally {
      clearInterval(leaseRenewal);
      activeSends.delete(recoveryKey);
    }
  };

  const collectRecentThreads = async (
    signal: AbortSignal,
  ): Promise<RecoveryThreadShape[]> => {
    const recentThreads: RecoveryThreadShape[] = [];
    let offset = 0;
    while (true) {
      const threads = await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit: THREAD_PAGE_SIZE,
        offset,
        signal,
      });
      for (const thread of threads) {
        if (thread.status !== "error" || thread.deletedAt !== null) continue;
        recentThreads.push({
          id: thread.id,
          projectId: thread.projectId,
          status: thread.status,
          archivedAt: thread.archivedAt,
          deletedAt: thread.deletedAt,
          updatedAt: thread.updatedAt,
        });
      }
      if (threads.length < THREAD_PAGE_SIZE) break;
      offset += THREAD_PAGE_SIZE;
    }
    return recentThreads
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, RECENT_THREAD_LIMIT);
  };

  const reconcileRecentThreadsOnce = async (signal: AbortSignal): Promise<void> => {
    if (!(await automaticEnabled())) return;
    const threads = await collectRecentThreads(signal);
    const candidates: Array<{
      thread: RecoveryThreadShape;
      candidate: RecoveryCandidate;
    }> = [];
    for (const thread of threads) {
      try {
        const candidate = await candidateFor(thread.id, signal);
        if (candidate !== null && candidate.hostDaemonErrorAt !== null) {
          candidates.push({ thread, candidate });
        }
      } catch (cause) {
        bb.log.warn(`Restart-resume inspection failed for ${thread.id}: ${errorText(cause)}`);
      }
    }

    const latestHostErrorAt = candidates.reduce<number | null>(
      (latest, { candidate }) =>
        candidate.hostDaemonErrorAt === null
          ? latest
          : latest === null
            ? candidate.hostDaemonErrorAt
            : Math.max(latest, candidate.hostDaemonErrorAt),
      null,
    );
    if (latestHostErrorAt === null) return;

    await Promise.all(
      candidates
        .filter(({ candidate }) =>
          candidate.interruption.createdAt !== undefined &&
          isWithinRecoveryWindow(candidate.interruption.createdAt, latestHostErrorAt),
        )
        .map(({ thread, candidate }) =>
          resumeThread(thread.id, {
            expectedInterruptionSeq: candidate.interruption.seq,
            recoveryAnchorAt: latestHostErrorAt,
            signal,
          }).catch((cause) => {
            bb.log.warn(`Restart-resume reconciliation failed for ${thread.id}: ${errorText(cause)}`);
          }),
        ),
    );
  };

  let reconciliationInFlight: Promise<void> | null = null;
  let reconciliationQueued = false;
  const reconciliationController = new AbortController();
  const reconcileRecentThreads = (): Promise<void> => {
    reconciliationQueued = true;
    if (reconciliationInFlight !== null) return reconciliationInFlight;

    const run = (async () => {
      while (reconciliationQueued && !reconciliationController.signal.aborted) {
        reconciliationQueued = false;
        await reconcileRecentThreadsOnce(reconciliationController.signal);
      }
    })();
    reconciliationInFlight = run;
    void run.then(
      () => {
        if (reconciliationInFlight === run) reconciliationInFlight = null;
      },
      () => {
        if (reconciliationInFlight === run) reconciliationInFlight = null;
      },
    );
    return run;
  };

  const retryDue = async (signal: AbortSignal): Promise<void> => {
    if (!(await automaticEnabled())) return;
    for (const threadId of store.dueThreadIds(Date.now(), THREAD_PAGE_SIZE)) {
      await resumeThread(threadId, { signal }).catch((cause) => {
        bb.log.warn(`Restart-resume retry failed for ${threadId}: ${errorText(cause)}`);
      });
    }
  };

  bb.events.on("thread.failed", () => {
    void reconcileRecentThreads().catch((cause) => {
      bb.log.warn(`Restart-resume event handler failed: ${errorText(cause)}`);
    });
  });

  bb.background.service("restart-resume-reconciler", {
    async start(signal) {
      if (signal.aborted) {
        reconciliationController.abort();
      } else {
        signal.addEventListener("abort", () => reconciliationController.abort(), { once: true });
      }
      await reconcileRecentThreads().catch((cause) => {
        bb.log.warn(`Restart-resume startup reconciliation failed: ${errorText(cause)}`);
      });
      while (!signal.aborted) {
        await sleep(RETRY_INTERVAL_MS, signal);
        if (signal.aborted) break;
        await retryDue(signal).catch((cause) => {
          bb.log.warn(`Restart-resume retry scan failed: ${errorText(cause)}`);
        });
      }
    },
  });

  bb.rpc.register(rpcContract, {
    async listProjects() {
      return { projects: await projectList() };
    },

    async saveProjectMessage({ projectId, message }) {
      const project = await projectResponse(projectId);
      if (message.trim() === "") {
        store.clearProjectMessage(projectId);
      } else {
        store.setProjectMessage(projectId, message, Date.now());
      }
      publishChange({ scope: "project", projectId });
      return { ...project, message: store.getProjectMessage(projectId) };
    },

    async clearProjectMessage({ projectId }) {
      const project = await projectResponse(projectId);
      store.clearProjectMessage(projectId);
      publishChange({ scope: "project", projectId });
      return { ...project, message: null };
    },

    async status() {
      return { automatic: await automaticEnabled(), ...store.counts() };
    },

    async resumeThread({ threadId }) {
      return resumeThread(threadId, { force: true });
    },
  });

  bb.cli.register({
    name: "restart-resume",
    summary: "Inspect or resume threads interrupted by a host daemon restart.",
    commands: [
      {
        name: "status",
        summary: "Show automatic mode and durable restart-resume counts.",
        usage: "bb restart-resume status [--json]",
      },
      {
        name: "resume",
        summary: "Manually resume the current or named thread.",
        usage: "bb restart-resume resume [thread-id] [--json]",
      },
    ],
    async run(argv, ctx) {
      const command = argv.find((argument) => !argument.startsWith("-")) ?? "status";
      const json = argv.includes("--json");
      if (command === "status") {
        const result = { automatic: await automaticEnabled(), ...store.counts() };
        return json
          ? { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n` }
          : {
              exitCode: 0,
              stdout: `Automatic: ${result.automatic ? "enabled" : "disabled"}\nPending: ${result.pending}\nResumed: ${result.resumed}\n`,
            };
      }
      if (command === "resume") {
        const explicitThreadId = argv.find(
          (argument) => argument !== "resume" && !argument.startsWith("-"),
        );
        const threadId = explicitThreadId ?? ctx.threadId;
        if (threadId === undefined) {
          return {
            exitCode: 2,
            stderr: "Run this command from inside a thread or provide a thread id.\n",
          };
        }
        const result = await resumeThread(threadId, { force: true, signal: ctx.signal });
        return json
          ? { exitCode: result.outcome === "failed" ? 1 : 0, stdout: `${JSON.stringify(result)}\n` }
          : {
              exitCode: result.outcome === "failed" ? 1 : 0,
              stdout: `${result.detail}\n`,
            };
      }
      return {
        exitCode: 2,
        stderr: "usage: bb restart-resume status [--json]\n       bb restart-resume resume [thread-id] [--json]\n",
      };
    },
  });
}
