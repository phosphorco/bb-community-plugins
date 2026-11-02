import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import {
  useBorrowedIdentityClient,
  useIdentitySession,
  useIdentityViewSnapshot,
} from "@phosphorco/bb-identity/react";
import {
  templatesContract,
  type LaunchStatus,
  type AssignmentStatus,
} from "../rpc-contract.ts";
import { eligibleCreatedThreadActor } from "../inbox-assignment-contract.ts";

function mergeAssignment(
  previous: AssignmentStatus | undefined,
  incoming: AssignmentStatus | undefined,
) {
  if (!previous) return incoming;
  if (
    !incoming ||
    incoming.operationId !== previous.operationId ||
    incoming.actorKey !== previous.actorKey ||
    (previous.threadId && incoming.threadId !== previous.threadId)
  )
    return previous;
  const receipt = previous.receipt ?? incoming.receipt,
    current =
      previous.current &&
      (!incoming.current ||
        previous.current.revision > incoming.current.revision)
        ? previous.current
        : incoming.current;
  return {
    ...incoming,
    ...(receipt ? { receipt, state: receipt.outcome, retryable: false } : {}),
    ...(current ? { current } : {}),
  };
}

/** Optional Inbox recovery never participates in thread-creation completion. */
export function AssignmentResult({ status }: { status: LaunchStatus }) {
  const rpc = useRpc<typeof templatesContract>(),
    client = useBorrowedIdentityClient(),
    session = useIdentitySession(),
    view = useIdentityViewSnapshot();
  const [assignment, setAssignment] = useState(status.assignment),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{
      kind: "read" | "write";
      message: string;
    } | null>(null);
  const generation = useRef(0),
    mounted = useRef(false),
    inFlight = useRef(false),
    accepted = useRef(status.assignment);
  const actor = session.status === "ready" ? session.actor.identity.key : null,
    stamp = session.status === "ready" ? session.stamp : null,
    allowed =
      session.status === "ready" &&
      eligibleCreatedThreadActor(session.actor) &&
      actor === status.assignment?.actorKey &&
      view.status === "ready" &&
      !view.overriding;
  const scope = `${status.operationId}:${actor}:${stamp}:${view.status}:${view.status === "ready" ? `${view.viewGeneration}:${view.overriding}` : ""}`;
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
    setBusy(inFlight.current);
    setError(null);
  }, [scope]);
  const accept = (incoming: AssignmentStatus | undefined) => {
    const previous = accepted.current,
      next = mergeAssignment(previous, incoming);
    accepted.current = next;
    setAssignment(next);
    return !!(
      (next?.receipt && !previous?.receipt) ||
      (next?.current &&
        (!previous?.current ||
          next.current.revision > previous.current.revision))
    );
  };
  useEffect(() => {
    const resolved = accept(status.assignment);
    // A successful journal/catalog read alone is not a successful provider
    // lookup. An explicit matching Check below can also clear unchanged errors.
    if (resolved) setError(null);
  }, [status.assignment]);

  const act = async (retry: boolean) => {
    if (
      !allowed ||
      inFlight.current ||
      !assignment ||
      (retry && !assignment.retryable)
    )
      return;
    const request = ++generation.current,
      capturedScope = scope,
      capturedActor = actor!,
      capturedStamp = stamp!;
    const current = () => {
      const live = client.currentSession();
      return (
        mounted.current &&
        generation.current === request &&
        liveScope.current === capturedScope &&
        live.ok &&
        live.value.status === "ready" &&
        live.value.actor.identity.key === capturedActor &&
        live.value.stamp === capturedStamp
      );
    };
    inFlight.current = true;
    setBusy(true);
    try {
      const next = retry
        ? await rpc.call("retryAssignment", {
            operationId: status.operationId,
            expectedActor: capturedActor,
            expectedSession: capturedStamp,
          })
        : await rpc.call("launchStatus", { operationId: status.operationId });
      if (!current()) return;
      if (
        !next?.assignment ||
        next.operationId !== status.operationId ||
        next.assignment.operationId !== assignment.operationId ||
        next.assignment.actorKey !== assignment.actorKey ||
        next.assignment.threadId !== assignment.threadId
      )
        throw new Error("No matching assignment receipt is available yet.");
      accept(next.assignment);
      setError((previous) =>
        !retry && previous?.kind === "write" && !next.assignment?.receipt
          ? previous
          : null,
      );
    } catch (cause) {
      if (current())
        setError({
          kind: retry ? "write" : "read",
          message: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (status.phase !== "succeeded" || !status.threadId || !assignment)
    return null;
  const current = assignment.current,
    originalOwns = current?.ownerKeys.includes(assignment.actorKey);
  const ownership = current
    ? originalOwns
      ? `Inbox: assigned to ${status.actor.name}${current.ownerKeys.length > 1 || current.truncated ? " and others" : ""}.`
      : current.truncated
        ? `Inbox: ownership list is partial; assignment to ${status.actor.name} is unknown.`
        : current.ownerKeys.length
          ? "Inbox: assigned to someone else."
          : "Inbox: unassigned."
    : null;
  const initial =
    assignment.receipt?.outcome === "claimed"
      ? "Initial Inbox assignment completed."
      : assignment.receipt?.outcome === "skipped-preserved"
        ? assignment.receipt.reason === "thread-ineligible"
          ? "Automatic Inbox assignment skipped; thread is no longer eligible."
          : "Automatic Inbox assignment skipped; existing ownership was preserved."
        : assignment.state === "pending"
          ? "Inbox assignment pending."
          : assignment.state === "unknown"
            ? "Inbox assignment outcome unknown."
            : "Inbox assignment unavailable.";
  return (
    <div className="ntt-stack ntt-small" aria-label="Inbox assignment">
      <div className="ntt-row">
        <span role="status">
          <span className="ntt-help">Last checked Inbox assignment: </span>
          <span>{ownership ?? initial}</span>
        </span>
        {allowed && (
          <button
            type="button"
            className="ntt-link"
            disabled={busy}
            onClick={() => void act(false)}
          >
            Check assignment
          </button>
        )}
        {allowed && assignment.retryable && (
          <button
            type="button"
            className="ntt-link"
            disabled={busy}
            onClick={() => void act(true)}
          >
            Retry assignment
          </button>
        )}
      </div>
      {ownership && assignment.receipt && !originalOwns && (
        <span className="ntt-help">{initial}</span>
      )}
      {assignment.message && (
        <span className="ntt-help">{assignment.message}</span>
      )}
      {error && (
        <span role="alert" className="ntt-alert">
          {error.message}
        </span>
      )}
    </div>
  );
}
