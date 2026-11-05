import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import {
  useBorrowedIdentityClient,
  useIdentitySession,
  useIdentityViewSnapshot,
} from "@phosphorco/bb-identity/react";
import {
  templatesContract,
  TEMPLATES_JOURNAL_CHANGED,
  type RecentLaunch,
} from "../rpc-contract.ts";
import { useMountedRead } from "./read.ts";
import { EffectsSummary } from "./destination.tsx";
import { RenderClock } from "./render-clock.tsx";
import { AssignmentResult } from "./assignment.tsx";

export function RecentLaunches({ onBack }: { onBack(): void }) {
  const rpc = useRpc<typeof templatesContract>();
  const [pageCount, setPageCount] = useState(1);
  const load = useCallback(async () => {
    const unique = new Map<string, RecentLaunch>();
    let nextOffset: number | null = 0;
    for (let index = 0; index < pageCount && nextOffset !== null; index++) {
      const page: { launches: RecentLaunch[]; nextOffset: number | null } =
        await rpc.call("recentLaunches", { offset: nextOffset });
      for (const item of page.launches)
        if (!unique.has(item.status.operationId))
          unique.set(item.status.operationId, item);
      // Byte-bounded pages can change size on refresh. Always follow the new
      // authoritative continuation, never a boundary retained from an old page.
      nextOffset = page.nextOffset;
    }
    return {
      launches: [...unique.values()],
      nextOffset,
    };
  }, [rpc, pageCount]);
  const recent = useMountedRead(load, TEMPLATES_JOURNAL_CHANGED);
  return (
    <div className="ntt-stack">
      <div className="ntt-row ntt-between">
        <button type="button" className="ntt-link" onClick={onBack}>
          ‹ Manage templates
        </button>
        <h3>History</h3>
      </div>
      {recent.error && (
        <div className="ntt-alert" role="alert">
          Recent launches could not refresh: {recent.error}
        </div>
      )}
      {recent.loading && !recent.value && (
        <p role="status">Loading recent launches…</p>
      )}
      {recent.value?.launches.map((launch) => (
        <LaunchReceipt
          key={launch.status.operationId}
          initial={launch}
          onChange={recent.refresh}
        />
      ))}
      {recent.value?.nextOffset !== null &&
        recent.value?.nextOffset !== undefined && (
          <button
            type="button"
            className="ntt-button"
            disabled={recent.loading}
            onClick={() => setPageCount((current) => current + 1)}
          >
            Load older launches
          </button>
        )}
      {recent.value && !recent.value.launches.length && (
        <p className="ntt-muted">No recent launches.</p>
      )}
    </div>
  );
}
function LaunchReceipt({
  initial,
  onChange,
}: {
  initial: RecentLaunch;
  onChange(): void;
}) {
  const rpc = useRpc<typeof templatesContract>(),
    navigate = useBbNavigate(),
    session = useIdentitySession(),
    view = useIdentityViewSnapshot(),
    client = useBorrowedIdentityClient();
  const [status, setStatus] = useState(initial.status),
    [error, setError] = useState<{
      kind: "read" | "write";
      message: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [details, setDetails] = useState(false);
  const generation = useRef(0),
    mounted = useRef(true),
    activeRequest = useRef<number | null>(null);
  const scope = `${session.status === "ready" ? `${session.actor.identity.key}:${session.stamp}` : session.status}:${view.status === "ready" ? `${view.viewGeneration}:${view.overriding}` : view.status}`;
  const liveScope = useRef(scope);
  liveScope.current = scope;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    activeRequest.current = null;
    setBusy(false);
    setError(null);
  }, [scope]);
  useEffect(() => {
    generation.current++;
    activeRequest.current = null;
    setBusy(false);
    setStatus(initial.status);
    setError((previous) =>
      previous?.kind === "read" ||
      initial.status.phase === "succeeded" ||
      initial.status.phase === "rejected"
        ? null
        : previous,
    );
  }, [initial.status]);
  const ownsRequest = (
    request: number,
    actor: string,
    stamp: string,
    capturedScope: string,
  ) => {
    const live = client.currentSession();
    return (
      mounted.current &&
      request === generation.current &&
      activeRequest.current === request &&
      liveScope.current === capturedScope &&
      live.ok &&
      live.value.status === "ready" &&
      live.value.actor.identity.key === actor &&
      live.value.stamp === stamp
    );
  };
  const check = async () => {
    if (activeRequest.current !== null || session.status !== "ready") return;
    setBusy(true);
    const request = ++generation.current,
      actor = session.actor.identity.key,
      stamp = session.stamp,
      capturedScope = scope;
    activeRequest.current = request;
    try {
      const authoritative = await rpc.call("launchStatus", {
        operationId: status.operationId,
      });
      if (!ownsRequest(request, actor, stamp, capturedScope)) return;
      if (authoritative) {
        setStatus(authoritative);
        setError(null);
        onChange();
      } else
        setError({
          kind: "read",
          message:
            "No receipt is available yet. This operation remains unknown and will not be resent.",
        });
    } catch (e) {
      if (ownsRequest(request, actor, stamp, capturedScope))
        setError({
          kind: "read",
          message: e instanceof Error ? e.message : String(e),
        });
    } finally {
      if (ownsRequest(request, actor, stamp, capturedScope)) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };
  const retry = async () => {
    if (
      activeRequest.current !== null ||
      status.phase !== "failed" ||
      !status.retryable ||
      session.status !== "ready" ||
      session.actor.identity.key !== status.actor.key ||
      view.status !== "ready" ||
      view.overriding
    )
      return;
    setBusy(true);
    const request = ++generation.current,
      actor = session.actor.identity.key,
      stamp = session.stamp,
      capturedScope = scope;
    activeRequest.current = request;
    try {
      const next = await rpc.call("launch", {
        operationId: status.operationId,
        templateId: status.templateId,
        revision: status.revision,
        inputs: status.inputs,
        ...(initial.requestedRenderContext
          ? { renderContext: initial.requestedRenderContext }
          : {}),
        ...(initial.requestedProjectId
          ? { projectId: initial.requestedProjectId }
          : {}),
        ...(initial.nativeSubmission
          ? { nativeSubmission: initial.nativeSubmission }
          : {}),
        expectedActor: session.actor.identity.key,
        expectedSession: session.stamp,
      });
      if (!ownsRequest(request, actor, stamp, capturedScope)) return;
      setStatus(next);
      setError(null);
      onChange();
      if (next.phase === "succeeded" && next.threadId)
        navigate.toThread(next.threadId);
    } catch (e) {
      if (ownsRequest(request, actor, stamp, capturedScope))
        setError({
          kind: "write",
          message: e instanceof Error ? e.message : String(e),
        });
    } finally {
      if (ownsRequest(request, actor, stamp, capturedScope)) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <article className="ntt-surface ntt-stack">
      <div className="ntt-row ntt-between">
        <div>
          <h3>{initial.revision.definition.name}</h3>
          <p className="ntt-help">
            Revision {status.revision} · {status.phase} · submitted by{" "}
            {status.actor.name}
          </p>
        </div>
        <button
          type="button"
          className="ntt-link"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          Details
        </button>
      </div>
      <p className="ntt-small">{status.message ?? "Preparing this launch."}</p>
      {error && (
        <p role="alert" className="ntt-alert">
          {error.message}
        </p>
      )}
      {initial.effects && <EffectsSummary effects={initial.effects} />}
      <div className="ntt-row">
        {status.phase === "succeeded" && status.threadId ? (
          <button
            type="button"
            className="ntt-button"
            onClick={() => navigate.toThread(status.threadId!)}
          >
            Open thread
          </button>
        ) : (
          <button
            type="button"
            className="ntt-button"
            disabled={busy}
            onClick={() => void check()}
          >
            Check launch status
          </button>
        )}
        {status.phase === "failed" &&
          status.retryable &&
          view.status === "ready" &&
          !view.overriding && (
            <button
              type="button"
              className="ntt-button"
              disabled={busy}
              onClick={() => void retry()}
            >
              Retry preparation
            </button>
          )}
      </div>
      {(status.renderContext ?? initial.renderContext) && (
        <RenderClock
          context={(status.renderContext ?? initial.renderContext)!}
        />
      )}
      {status.sampleCapture?.state === "unavailable" && (
        <p className="ntt-help" role="status">
          Thread started. Recent sample could not be saved:{" "}
          {status.sampleCapture.message}
        </p>
      )}
      {status.phase === "succeeded" && status.assignment && (
        <AssignmentResult key={status.operationId} status={status} />
      )}
      {details && (
        <div className="ntt-stack">
          <p className="ntt-help">
            Native attribution: plugin origin. Templates retains the captured
            submitting actor.
          </p>
          <div>
            <strong>Submitted inputs</strong>
            <pre className="ntt-preview">
              {JSON.stringify(status.inputs, null, 2)}
            </pre>
          </div>
          <div>
            <strong>Pinned first message</strong>
            <pre className="ntt-preview">
              {initial.effects?.prompt ??
                "Preparation has not resolved a first message yet."}
            </pre>
          </div>
        </div>
      )}
    </article>
  );
}
