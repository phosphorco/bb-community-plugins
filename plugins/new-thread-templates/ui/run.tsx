import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import {
  useBorrowedIdentityClient,
  useIdentitySession,
  useIdentityStateBinding,
  useIdentityStateSnapshot,
  useIdentityViewSnapshot,
} from "@phosphorco/bb-identity/react";
import {
  defaultInputs,
  createRenderContext,
  inputDraftResource,
  validateInputs,
  type Inputs,
  type PersonalDraft,
  type PublishedRevision,
  type ValidationIssue,
  type NativeEditorOrigin,
} from "../model.ts";
import {
  templatesContract,
  TEMPLATES_CHANGED,
  type LaunchStatus,
  type LaunchRequest,
} from "../rpc-contract.ts";
import type { DraftStorage } from "@phosphorco/bb-identity/state";
import type { Result } from "@phosphorco/bb-identity/model";
import { TemplatePurposeIcon } from "./icon.tsx";
import { AssignmentResult } from "./assignment.tsx";
import { RenderClock } from "./render-clock.tsx";
import { InputFields } from "./fields.tsx";
import { EffectsSummary, ProjectSelect } from "./destination.tsx";
import { useMountedRead } from "./read.ts";
import {
  decodeNativeSubmission,
  publicNativeSeed,
} from "../native-submission.ts";
import {
  NativeTemplateEditor,
  nativeEditorDraftKey,
} from "./native-editor.tsx";

export function TemplateRun({
  template,
  projectId,
  drafts,
  onBack,
  onEdit,
}: {
  template: PublishedRevision;
  projectId: string | null;
  drafts: DraftStorage<PersonalDraft>;
  onBack(): void;
  onEdit(): void;
}) {
  const rpc = useRpc<typeof templatesContract>(),
    navigate = useBbNavigate(),
    client = useBorrowedIdentityClient(),
    session = useIdentitySession(),
    view = useIdentityViewSnapshot();
  const binding = useIdentityStateBinding({
    resource: inputDraftResource,
    recordId: template.templateId,
    target: "viewed-subject",
    editPolicy: "actor-only",
    initializeEmpty: true,
    drafts,
    onConflict: () => ({
      kind: "needs-review",
      reason:
        "These inputs changed in another view. Choose which version to keep.",
    }),
  });
  const snapshot = useIdentityStateSnapshot(binding);
  const personal =
    snapshot.status === "ready"
      ? snapshot.desired
      : snapshot.status === "blocked" || snapshot.status === "detached"
        ? snapshot.draft?.desired
        : null;
  const inputs = useMemo(
    () => ({ ...defaultInputs(template.definition), ...personal?.inputs }),
    [template, personal?.inputs],
  );
  const chosen = personal?.projectId ?? projectId ?? "";
  const [nativeMode, setNativeMode] = useState(false),
    [nativeVisited, setNativeVisited] = useState(false),
    [openingEditor, setOpeningEditor] = useState(false);
  const [activeNativeOrigin, setActiveNativeOrigin] =
    useState<NativeEditorOrigin | null>(null);
  const noDispatch = useRef(
    new Map<
      string,
      {
        actor: string;
        instanceId: string;
        binding: NonNullable<typeof binding>;
        ownerSession: ReturnType<
          NonNullable<typeof binding>["currentOwnerSession"]
        >;
      }
    >(),
  );
  const [noDispatchEpoch, setNoDispatchEpoch] = useState(0);
  const createdEditors = useRef(new Set<string>());
  const interruptedEditors = useRef(new Set<string>());
  const [details, setDetails] = useState(false),
    [issues, setIssues] = useState<ValidationIssue[]>([]),
    [writeError, setWriteError] = useState<string | null>(null),
    [sending, setSending] = useState(false);
  const [operation, setOperation] = useState<LaunchStatus | null>(null),
    [checking, setChecking] = useState(false);
  const [recovery, setRecovery] = useState<Awaited<
    ReturnType<NonNullable<typeof binding>["recoveryCandidates"]>
  > | null>(null);
  const [recoveryFailure, setRecoveryFailure] = useState<{
    action: string;
    message: string;
  } | null>(null);
  const recoveryGeneration = useRef(0);
  const form = useRef<HTMLFormElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    issuing = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => heading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const ownerSession = binding?.currentOwnerSession();
  useEffect(() => {
    setWriteError(null);
    setOperation(null);
    setRecovery(null);
    setRecoveryFailure(null);
    recoveryGeneration.current++;
    setIssues([]);
    setNativeMode(false);
    setActiveNativeOrigin(null);
    setNativeVisited(false);
    setOpeningEditor(false);
  }, [ownerSession]);
  const readonly = view.status === "ready" && view.overriding;
  const ready = snapshot.status === "ready" && !readonly;
  useEffect(() => {
    if (snapshot.status === "ready")
      setRecoveryFailure((previous) =>
        previous?.action === "reconnect" ? null : previous,
      );
  }, [snapshot.status]);
  async function recoveryCommand<T>(
    action: string,
    run: (
      captured: NonNullable<typeof binding>,
      owner: NonNullable<
        ReturnType<NonNullable<typeof binding>["currentOwnerSession"]>
      >,
    ) => Promise<Result<T>>,
    accept?: (value: T) => void,
  ) {
    const captured = binding,
      owner = captured?.currentOwnerSession();
    if (!captured || !owner || session.status !== "ready") return;
    const request = ++recoveryGeneration.current,
      actor = session.actor.identity.key,
      stamp = session.stamp;
    const current = () => {
      const live = client.currentSession();
      return (
        mounted.current &&
        request === recoveryGeneration.current &&
        captured.currentOwnerSession() === owner &&
        live.ok &&
        live.value.status === "ready" &&
        live.value.actor.identity.key === actor &&
        live.value.stamp === stamp
      );
    };
    try {
      const result = await run(captured, owner);
      if (!current()) return;
      if (!result.ok) {
        setRecoveryFailure({ action, message: result.error.message });
        return;
      }
      accept?.(result.value);
      setRecoveryFailure((previous) =>
        previous?.action === action ? null : previous,
      );
    } catch (error) {
      if (current())
        setRecoveryFailure({
          action,
          message: error instanceof Error ? error.message : String(error),
        });
    }
  }
  const acknowledgedPersonal =
    snapshot.status === "ready"
      ? snapshot.acknowledged.status === "present"
        ? snapshot.acknowledged.envelope.value
        : null
      : (snapshot.status === "blocked" || snapshot.status === "detached") &&
          snapshot.draft?.acknowledged.status === "present"
        ? snapshot.draft.acknowledged.envelope.value
        : null;
  const operationId =
    personal?.operationId ?? acknowledgedPersonal?.operationId;
  const savedCheckpoint =
    personal?.launchCheckpoint ?? acknowledgedPersonal?.launchCheckpoint;
  // A completed reference stays pending until its removal is acknowledged.
  const pending = !!operationId;
  const loadContext = useCallback(
    () => rpc.call("context", { ...(chosen ? { projectId: chosen } : {}) }),
    [rpc, chosen],
  );
  const context = useMountedRead(loadContext, TEMPLATES_CHANGED);
  const initialClock = useMemo(
    () => createRenderContext(template.definition.timeZone ?? "UTC"),
    [
      ownerSession,
      template.templateId,
      template.revision,
      template.definition.timeZone,
    ],
  );
  const renderContext = personal?.renderContext ?? initialClock;
  const signature = JSON.stringify({
    definition: template.definition,
    inputs,
    projectId: chosen,
    renderContext,
  });
  const [settled, setSettled] = useState(signature);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(signature), 250);
    return () => clearTimeout(timer);
  }, [signature]);
  const loadPreview = useCallback(async () => {
    const captured = JSON.parse(settled) as {
      definition: PublishedRevision["definition"];
      inputs: Inputs;
      projectId: string;
      renderContext: typeof renderContext;
    };
    return {
      signature: settled,
      result: await rpc.call("preview", {
        definition: captured.definition,
        inputs: captured.inputs,
        renderContext: captured.renderContext,
        ...(captured.projectId ? { projectId: captured.projectId } : {}),
      }),
    };
  }, [rpc, settled]);
  const preview = useMountedRead(loadPreview, TEMPLATES_CHANGED);
  const currentPreview =
    preview.value?.signature === signature ? preview.value.result : null;
  const loadHistory = useCallback(
    async () =>
      operationId ? rpc.call("recentLaunches", {}) : { launches: [] },
    [rpc, operationId],
  );
  const history = useMountedRead(loadHistory, TEMPLATES_CHANGED);
  const receipt = history.value?.launches.find(
    (launch) => launch.status.operationId === operationId,
  );
  const effective = pending
    ? (receipt?.effects ?? null)
    : (currentPreview?.effects ?? null);
  const edit = (next: PersonalDraft) => {
    const result = binding?.edit(next);
    if (result && !result.ok) setWriteError(result.error.message);
  };
  const changeInputs = (next: Inputs) => {
    const current = binding?.getSnapshot();
    if (current?.status !== "ready") return;
    edit({
      ...current.desired,
      inputs: next,
      renderContext: current.desired.renderContext ?? renderContext,
    });
    setIssues([]);
  };
  const changeProject = (projectId: string) => {
    const current = binding?.getSnapshot();
    if (current?.status !== "ready") return;
    edit({
      ...current.desired,
      projectId,
      renderContext: current.desired.renderContext ?? renderContext,
    });
  };
  const refreshTime = () => {
    const current = binding?.getSnapshot();
    if (!ready || busy || pending || current?.status !== "ready") return;
    edit({
      ...current.desired,
      renderContext: createRenderContext(template.definition.timeZone ?? "UTC"),
    });
  };
  const loadStatus = useCallback(
    async () =>
      operationId
        ? {
            id: operationId,
            status: await rpc.call("launchStatus", { operationId }),
          }
        : null,
    [rpc, operationId],
  );
  const journal = useMountedRead(loadStatus, TEMPLATES_CHANGED);
  const matchesOperation = (
    captured: NonNullable<typeof binding>,
    id: string,
  ) => {
    const current = captured.getSnapshot();
    const desired =
      current.status === "ready"
        ? current.desired
        : current.status === "blocked" || current.status === "detached"
          ? current.draft?.desired
          : null;
    const base =
      current.status === "ready"
        ? current.acknowledged
        : current.status === "blocked" || current.status === "detached"
          ? current.draft?.acknowledged
          : null;
    const currentId =
      desired?.operationId ??
      (base?.status === "present" ? base.envelope.value.operationId : null);
    return !currentId || currentId === id;
  };
  const currentCompletionOwner = (
    captured: NonNullable<typeof binding>,
    owner: ReturnType<NonNullable<typeof binding>["currentOwnerSession"]>,
    actor: string,
    stamp: string,
    id: string,
  ) => {
    const live = client.currentSession();
    return (
      mounted.current &&
      captured.currentOwnerSession() === owner &&
      live.ok &&
      live.value.status === "ready" &&
      live.value.actor.identity.key === actor &&
      live.value.stamp === stamp &&
      matchesOperation(captured, id)
    );
  };
  const completionFailure = useRef<{
    id: string;
    binding: NonNullable<typeof binding>;
    actor: string;
    stamp: string;
  } | null>(null);
  useEffect(() => {
    const failure = completionFailure.current;
    const live = client.currentSession();
    if (
      !failure ||
      failure.binding !== binding ||
      snapshot.status !== "ready" ||
      snapshot.dirty ||
      snapshot.saving ||
      readonly ||
      !live.ok ||
      live.value.status !== "ready" ||
      live.value.actor.identity.key !== failure.actor ||
      live.value.stamp !== failure.stamp ||
      snapshot.desired.operationId ||
      snapshot.acknowledged.status !== "present" ||
      snapshot.acknowledged.envelope.value.operationId
    )
      return;
    // A successful personal-state reconciliation resolves this exact cleanup
    // failure, including an unchanged already-committed removal receipt.
    completionFailure.current = null;
    setWriteError(null);
  }, [snapshot, binding, client, readonly]);
  const completion = useRef<{
    id: string;
    binding: NonNullable<typeof binding>;
    owner: ReturnType<NonNullable<typeof binding>["currentOwnerSession"]>;
    promise: Promise<boolean>;
  } | null>(null);
  const acknowledgeSuccess = useCallback(
    (
      status: LaunchStatus,
      captured: NonNullable<typeof binding>,
      owner: ReturnType<NonNullable<typeof binding>["currentOwnerSession"]>,
      actor: string,
      stamp: string,
    ) => {
      const prior = completion.current;
      if (
        prior?.id === status.operationId &&
        prior.binding === captured &&
        prior.owner === owner
      )
        return prior.promise;
      const isCurrent = () =>
        currentCompletionOwner(
          captured,
          owner,
          actor,
          stamp,
          status.operationId,
        );
      const promise = (async () => {
        if (
          status.phase !== "succeeded" ||
          !status.threadId ||
          status.actor.key !== actor ||
          !isCurrent()
        )
          return false;
        try {
          const current = captured.getSnapshot();
          if (current.status !== "ready") {
            completionFailure.current = {
              id: status.operationId,
              binding: captured,
              actor,
              stamp,
            };
            return false;
          }
          if (
            current.desired.operationId &&
            current.desired.operationId !== status.operationId
          )
            return false;
          const acknowledgedId =
            current.acknowledged.status === "present"
              ? current.acknowledged.envelope.value.operationId
              : null;
          if (current.desired.operationId === status.operationId) {
            const {
              operationId: _id,
              nativeOperation: _native,
              launchCheckpoint: _launchCheckpoint,
              revision: _revision,
              ...retained
            } = current.desired;
            const edited = captured.edit(retained);
            if (!edited.ok) throw new Error(edited.error.message);
          } else if (acknowledgedId !== status.operationId) return true;
          const saved = await captured.flush();
          if (!isCurrent()) return false;
          if (!saved.ok) throw new Error(saved.error.message);
          const after = captured.getSnapshot();
          if (after.status !== "ready" || after.desired.operationId)
            return false;
          if (
            after.acknowledged.status !== "present" ||
            after.acknowledged.envelope.value.operationId === status.operationId
          )
            return false;
          setWriteError(null);
          return true;
        } catch (error) {
          if (isCurrent()) {
            completionFailure.current = {
              id: status.operationId,
              binding: captured,
              actor,
              stamp,
            };
            setWriteError(
              `Thread started. Personal inputs could not finish saving: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return false;
        }
      })();
      completion.current = {
        id: status.operationId,
        binding: captured,
        owner,
        promise,
      };
      void promise.then(() => {
        if (completion.current?.promise === promise) completion.current = null;
      });
      return promise;
    },
    [client],
  );
  useEffect(() => {
    const status = journal.value?.status;
    if (!status || journal.value?.id !== operationId) return;
    setOperation(status);
    if (
      status.phase === "succeeded" &&
      status.threadId &&
      !readonly &&
      session.status === "ready" &&
      status.actor.key === session.actor.identity.key &&
      binding
    ) {
      // Selecting a template means reuse. Recovery never passively navigates.
      void acknowledgeSuccess(
        status,
        binding,
        binding.currentOwnerSession(),
        session.actor.identity.key,
        session.stamp,
      );
    }
    if (status.phase === "failed" || status.phase === "rejected")
      setWriteError(
        status.message ??
          "The thread could not start. Your inputs are retained.",
      );
  }, [
    journal.value,
    operationId,
    readonly,
    session,
    binding,
    snapshot.status,
    acknowledgeSuccess,
  ]);
  const focusFirst = (errors: ValidationIssue[]) =>
    requestAnimationFrame(() => {
      const first = errors[0]?.path;
      if (first?.startsWith("destination") || first === "projectId") {
        form.current?.querySelector<HTMLElement>("#ntt-project")?.focus();
        return;
      }
      const input = [
        ...(form.current?.querySelectorAll<HTMLElement>("[data-field]") ?? []),
      ].find((el) => el.dataset.field === first);
      (
        input ??
        form.current?.querySelector<HTMLElement>("[aria-invalid=true]") ??
        form.current?.querySelector<HTMLElement>("[data-form-error]")
      )?.focus();
    });
  // Persisted origin admits an opening/reset; a mounted editor keeps that frozen
  // origin even if another client later replaces the shared native draft pointer.
  const acknowledgedNativeOrigin =
    snapshot.status === "ready" && snapshot.acknowledged.status === "present"
      ? snapshot.acknowledged.envelope.value.nativeEditor
      : undefined;
  const nativeOrigin = activeNativeOrigin ?? acknowledgedNativeOrigin;
  useEffect(() => {
    const live = client.currentSession();
    if (
      !binding ||
      snapshot.status !== "ready" ||
      readonly ||
      !live.ok ||
      live.value.status !== "ready"
    )
      return;
    for (const [id, proof] of noDispatch.current) {
      if (
        proof.binding !== binding ||
        live.value.actor.identity.key !== proof.actor ||
        live.value.instanceId !== proof.instanceId ||
        snapshot.address.owner !== proof.actor
      )
        continue;
      const acknowledgedId =
        snapshot.acknowledged.status === "present"
          ? snapshot.acknowledged.envelope.value.operationId
          : null;
      // A local edit is not an acknowledgement. Keep proof through failed or
      // response-lost cleanup writes, until shared state confirms removal.
      if (
        !snapshot.dirty &&
        !snapshot.saving &&
        acknowledgedId !== id &&
        snapshot.desired.operationId !== id
      ) {
        noDispatch.current.delete(id);
        continue;
      }
      if (snapshot.desired.operationId !== id) continue;
      // This captured binding failed before rpc.call. Null journal reads never
      // grant permission to clear a possibly dispatched operation.
      const {
        operationId: _id,
        revision: _revision,
        nativeOperation: _native,
        launchCheckpoint: _launchCheckpoint,
        ...retained
      } = snapshot.desired;
      const cleared = binding.edit(retained);
      if (cleared.ok) {
        setOperation(null);
        setWriteError(null);
        void binding.flush();
      }
    }
  }, [snapshot, noDispatchEpoch, readonly, binding, client]);
  useEffect(() => {
    if (nativeVisited && nativeOrigin && !ready)
      interruptedEditors.current.add(nativeOrigin.editorDraftId);
  }, [nativeVisited, nativeOrigin, ready]);
  const ownsNative =
    !!nativeOrigin &&
    session.status === "ready" &&
    nativeOrigin.instanceId === session.instanceId &&
    nativeOrigin.actor === session.actor.identity.key &&
    nativeOrigin.templateId === template.templateId &&
    !readonly;
  const openNative = async (reset = false) => {
    if (
      !ready ||
      pending ||
      !binding ||
      session.status !== "ready" ||
      openingEditor
    )
      return;
    if (ownsNative && nativeOrigin?.renderContext && !reset) {
      setActiveNativeOrigin(nativeOrigin!);
      setNativeVisited(true);
      setNativeMode(true);
      return;
    }
    if (
      reset &&
      ownsNative &&
      !window.confirm(
        "Replace this BB editor draft with a fresh generated prompt? Unsent edits in this editor will no longer be shown.",
      )
    )
      return;
    const legacyOrigin = ownsNative && !reset ? nativeOrigin : null;
    const validation = legacyOrigin
      ? { inputs: legacyOrigin.inputs, issues: [] }
      : validateInputs(template.definition, inputs);
    setIssues(validation.issues);
    if (validation.issues.length) {
      setNativeMode(false);
      focusFirst(validation.issues);
      return;
    }
    const seed = legacyOrigin?.seed ?? currentPreview?.nativeSeed;
    if (!seed || (!legacyOrigin && !currentPreview?.effects?.projectId)) {
      setWriteError(
        "BB editor is available for existing projects. This template creates its project when sent.",
      );
      return;
    }
    const captured = binding,
      owner = captured.currentOwnerSession(),
      actor = session.actor.identity.key,
      stamp = session.stamp;
    const origin: NativeEditorOrigin = legacyOrigin
      ? {
          ...legacyOrigin,
          renderContext: createRenderContext(
            template.definition.timeZone ?? "UTC",
          ),
        }
      : {
          editorDraftId: crypto.randomUUID(),
          instanceId: session.instanceId,
          actor,
          templateId: template.templateId,
          revision: template.revision,
          inputs: structuredClone(validation.inputs),
          ...(chosen ? { projectId: chosen } : {}),
          seed: structuredClone(seed),
          title: currentPreview!.effects!.title,
          createdAt: Date.now(),
          renderContext: structuredClone(
            currentPreview!.renderContext ?? renderContext,
          ),
        };
    createdEditors.current.add(origin.editorDraftId);
    setOpeningEditor(true);
    try {
      const live = captured.getSnapshot();
      if (live.status !== "ready")
        throw new Error("Personal inputs are not ready.");
      const edited = captured.edit({
        ...live.desired,
        renderContext: live.desired.renderContext ?? renderContext,
        nativeEditor: origin,
      });
      if (!edited.ok) throw new Error(edited.error.message);
      const saved = await captured.flush();
      if (!saved.ok) throw new Error(saved.error.message);
      const after = client.currentSession();
      if (
        !mounted.current ||
        captured.currentOwnerSession() !== owner ||
        !after.ok ||
        after.value.status !== "ready" ||
        after.value.actor.identity.key !== actor ||
        after.value.stamp !== stamp
      )
        return;
      setActiveNativeOrigin(origin);
      setNativeVisited(true);
      setNativeMode(true);
      setWriteError(null);
    } catch (error) {
      if (mounted.current && captured.currentOwnerSession() === owner)
        setWriteError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current && captured.currentOwnerSession() === owner)
        setOpeningEditor(false);
    }
  };
  const submitNative = async (value: NewThreadRequest) => {
    if (
      issuing.current ||
      openingEditor ||
      pending ||
      !ready ||
      !binding ||
      !ownsNative ||
      !nativeOrigin ||
      session.status !== "ready"
    )
      throw new Error(
        "A saved operation or identity change is blocking this editor. Check its status before sending.",
      );
    const nativeSubmission = decodeNativeSubmission(value),
      origin = structuredClone(nativeOrigin),
      captured = binding,
      owner = captured.currentOwnerSession(),
      actor = session.actor.identity.key,
      stamp = session.stamp,
      id = crypto.randomUUID();
    const nativeOperation = {
      templateId: origin.templateId,
      revision: origin.revision,
      inputs: origin.inputs,
      ...(origin.projectId ? { projectId: origin.projectId } : {}),
      nativeSubmission,
      ...(origin.renderContext ? { renderContext: origin.renderContext } : {}),
    };
    const request: LaunchRequest = {
      operationId: id,
      ...nativeOperation,
      expectedActor: actor,
      expectedSession: stamp,
    };
    issuing.current = true;
    setSending(true);
    setOperation(null);
    let dispatched = false;
    try {
      const current = captured.getSnapshot();
      if (current.status !== "ready")
        throw new Error("Personal inputs are not ready.");
      const edited = captured.edit({
        ...current.desired,
        operationId: id,
        revision: origin.revision,
        nativeOperation,
        launchCheckpoint: { version: 1, request },
      });
      if (!edited.ok) throw new Error(edited.error.message);
      const saved = await captured.flush();
      if (!saved.ok) throw new Error(saved.error.message);
      const live = client.currentSession();
      if (
        !mounted.current ||
        captured.currentOwnerSession() !== owner ||
        !live.ok ||
        live.value.status !== "ready" ||
        live.value.actor.identity.key !== actor ||
        live.value.stamp !== stamp
      )
        throw new Error(
          "Identity or view changed before sending. No launch request was sent.",
        );
      dispatched = true;
      const status = await rpc.call("launch", request);
      const after = client.currentSession();
      if (
        !mounted.current ||
        captured.currentOwnerSession() !== owner ||
        !after.ok ||
        after.value.status !== "ready" ||
        after.value.actor.identity.key !== actor ||
        after.value.stamp !== stamp ||
        !matchesOperation(captured, id)
      )
        throw new Error(
          "The request remains with its original owner. Reopen that owner’s recovery to check it.",
        );
      setOperation(status);
      if (status.phase !== "succeeded" || !status.threadId)
        throw new Error(
          status.message ??
            "The launch is not confirmed. Check its status without resending.",
        );
      if (!(await acknowledgeSuccess(status, captured, owner, actor, stamp)))
        throw new Error(
          "Thread started. Reconnect inputs to finish saving, or open the confirmed thread.",
        );
      if (!currentCompletionOwner(captured, owner, actor, stamp, id))
        throw new Error("The confirmed thread stays with its original owner.");
      setWriteError(null);
      navigate.toThread(status.threadId);
    } catch (error) {
      if (!dispatched) {
        noDispatch.current.set(id, {
          actor,
          instanceId: session.instanceId,
          binding: captured,
          ownerSession: owner,
        });
        setNoDispatchEpoch((value) => value + 1);
        const current = captured.getSnapshot();
        if (
          current.status === "ready" &&
          captured.currentOwnerSession() === owner
        ) {
          const {
            operationId: _id,
            revision: _revision,
            nativeOperation: _native,
            launchCheckpoint: _launchCheckpoint,
            ...retained
          } = current.desired;
          captured.edit(retained);
          void captured.flush();
        }
      }
      if (
        mounted.current &&
        captured.currentOwnerSession() === owner &&
        matchesOperation(captured, id)
      )
        setWriteError(
          `${error instanceof Error ? error.message : String(error)} BB keeps the edited draft. ${dispatched ? "Check the same operation before any new send." : "No launch request was sent."}`,
        );
      throw error;
    } finally {
      issuing.current = false;
      if (mounted.current && captured.currentOwnerSession() === owner)
        setSending(false);
      journal.refresh();
    }
  };
  const submit = async () => {
    if (
      issuing.current ||
      pending ||
      !ready ||
      !binding ||
      session.status !== "ready"
    )
      return;
    const validation = validateInputs(template.definition, inputs);
    setIssues(validation.issues);
    if (validation.issues.length) {
      focusFirst(validation.issues);
      return;
    }
    if (!effective) {
      const errors = currentPreview?.issues ?? [
        {
          path: "destination",
          message: "Wait for the final destination and model to resolve.",
        },
      ];
      setIssues(errors);
      focusFirst(errors);
      return;
    }
    issuing.current = true;
    setSending(true);
    setOperation(null);
    setWriteError(null);
    const captured = binding,
      owner = captured.currentOwnerSession(),
      actor = session.actor.identity.key,
      stamp = session.stamp,
      id = crypto.randomUUID();
    let dispatched = false;
    const request: LaunchRequest = {
      operationId: id,
      templateId: template.templateId,
      revision: template.revision,
      inputs: structuredClone(validation.inputs),
      renderContext: structuredClone(
        currentPreview?.renderContext ?? renderContext,
      ),
      ...(chosen ? { projectId: chosen } : {}),
      expectedActor: actor,
      expectedSession: stamp,
    };
    try {
      const {
        nativeOperation: _previousNative,
        launchCheckpoint: _previousCheckpoint,
        ...directBase
      } = personal ?? {
        inputs,
      };
      const result = captured.edit({
        ...directBase,
        inputs: request.inputs,
        renderContext: request.renderContext,
        ...(chosen ? { projectId: chosen } : {}),
        operationId: id,
        revision: template.revision,
        launchCheckpoint: { version: 1, request },
      });
      if (!result.ok) throw new Error(result.error.message);
      const saved = await captured.flush();
      if (!saved.ok) throw new Error(saved.error.message);
      const live = client.currentSession();
      if (
        !live.ok ||
        live.value.status !== "ready" ||
        live.value.actor.identity.key !== actor ||
        live.value.stamp !== stamp ||
        captured.currentOwnerSession() !== owner ||
        !mounted.current
      ) {
        const current = captured.getSnapshot();
        if (
          current.status === "ready" &&
          captured.currentOwnerSession() === owner
        ) {
          const {
            operationId: _id,
            nativeOperation: _nativeOperation,
            launchCheckpoint: _launchCheckpoint,
            revision: _revision,
            ...retained
          } = current.desired;
          captured.edit(retained);
          void captured.flush();
        }
        throw new Error(
          "Your identity or view changed before launch. No launch request was sent.",
        );
      }
      dispatched = true;
      const status = await rpc.call("launch", request);
      const after = client.currentSession();
      if (
        !mounted.current ||
        captured.currentOwnerSession() !== owner ||
        !after.ok ||
        after.value.status !== "ready" ||
        after.value.actor.identity.key !== actor ||
        after.value.stamp !== stamp ||
        !matchesOperation(captured, id)
      )
        return;
      setOperation(status);
      if (status.phase === "succeeded" && status.threadId) {
        if (await acknowledgeSuccess(status, captured, owner, actor, stamp)) {
          if (currentCompletionOwner(captured, owner, actor, stamp, id))
            navigate.toThread(status.threadId);
        }
      } else if (status.phase === "failed" || status.phase === "rejected")
        setWriteError(
          status.message ?? "The thread could not start. Inputs are retained.",
        );
    } catch (error) {
      if (!dispatched) {
        noDispatch.current.set(id, {
          actor,
          instanceId: session.instanceId,
          binding: captured,
          ownerSession: owner,
        });
        setNoDispatchEpoch((value) => value + 1);
        const current = captured.getSnapshot();
        if (
          current.status === "ready" &&
          captured.currentOwnerSession() === owner
        ) {
          const {
            operationId: _id,
            nativeOperation: _nativeOperation,
            launchCheckpoint: _launchCheckpoint,
            revision: _revision,
            ...retained
          } = current.desired;
          captured.edit(retained);
          void captured.flush();
        }
      }
      if (
        mounted.current &&
        captured.currentOwnerSession() === owner &&
        matchesOperation(captured, id)
      )
        setWriteError(
          `${error instanceof Error ? error.message : String(error)} Inputs are retained. ${dispatched ? "Check launch status before taking another action." : "No launch request was sent."}`,
        );
    } finally {
      issuing.current = false;
      if (mounted.current) setSending(false);
      journal.refresh();
    }
  };
  const retryPreparation = async () => {
    if (
      issuing.current ||
      !operation ||
      operation.phase !== "failed" ||
      !operation.retryable ||
      !ready ||
      session.status !== "ready" ||
      operation.actor.key !== session.actor.identity.key
    )
      return;
    issuing.current = true;
    setSending(true);
    const currentBinding = binding,
      owner = currentBinding?.currentOwnerSession();
    try {
      const immutable = personal?.nativeOperation ?? {
        templateId: operation.templateId,
        revision: operation.revision,
        inputs: operation.inputs,
        ...(personal?.projectId ? { projectId: personal.projectId } : {}),
      };
      const result =
        savedCheckpoint?.request.operationId === operation.operationId
          ? await rpc.call("resumeLaunch", {
              checkpoint: savedCheckpoint,
              expectedActor: session.actor.identity.key,
              expectedSession: session.stamp,
            })
          : await rpc.call("launch", {
              operationId: operation.operationId,
              ...immutable,
              expectedActor: session.actor.identity.key,
              expectedSession: session.stamp,
            });
      const after = client.currentSession();
      if (
        !mounted.current ||
        currentBinding?.currentOwnerSession() !== owner ||
        !after.ok ||
        after.value.status !== "ready" ||
        after.value.actor.identity.key !== session.actor.identity.key ||
        after.value.stamp !== session.stamp ||
        !currentBinding ||
        !matchesOperation(currentBinding, operation.operationId)
      )
        return;
      setOperation(result);
      if (result.phase === "succeeded" && result.threadId && currentBinding) {
        if (
          await acknowledgeSuccess(
            result,
            currentBinding,
            owner ?? null,
            session.actor.identity.key,
            session.stamp,
          )
        ) {
          if (
            currentCompletionOwner(
              currentBinding,
              owner ?? null,
              session.actor.identity.key,
              session.stamp,
              result.operationId,
            )
          )
            navigate.toThread(result.threadId);
        }
      } else if (result.phase === "failed")
        setWriteError(result.message ?? "Preparation failed.");
    } catch (e) {
      if (
        mounted.current &&
        currentBinding &&
        currentBinding.currentOwnerSession() === owner &&
        matchesOperation(currentBinding, operation.operationId)
      )
        setWriteError(
          `${e instanceof Error ? e.message : String(e)} Check the same operation status; it will not be resent automatically.`,
        );
    } finally {
      issuing.current = false;
      if (mounted.current) setSending(false);
      journal.refresh();
    }
  };
  const check = async () => {
    setChecking(true);
    journal.refresh();
    setChecking(false);
  };
  const resumeSaved = async () => {
    if (
      issuing.current ||
      !ready ||
      !binding ||
      session.status !== "ready" ||
      !savedCheckpoint ||
      savedCheckpoint.request.operationId !== operationId ||
      savedCheckpoint.request.expectedActor !== session.actor.identity.key ||
      operation ||
      journal.error ||
      journal.loading
    )
      return;
    const captured = binding,
      owner = captured.currentOwnerSession(),
      actor = session.actor.identity.key,
      stamp = session.stamp,
      id = savedCheckpoint.request.operationId;
    issuing.current = true;
    setSending(true);
    try {
      const result = await rpc.call("resumeLaunch", {
        checkpoint: savedCheckpoint,
        expectedActor: actor,
        expectedSession: stamp,
      });
      if (!currentCompletionOwner(captured, owner, actor, stamp, id)) return;
      setOperation(result);
      if (result.phase === "succeeded" && result.threadId) {
        if (
          (await acknowledgeSuccess(result, captured, owner, actor, stamp)) &&
          currentCompletionOwner(captured, owner, actor, stamp, id)
        )
          navigate.toThread(result.threadId);
      } else if (result.phase === "failed" || result.phase === "rejected")
        setWriteError(
          result.message ??
            "The saved request could not start. Inputs are retained.",
        );
    } catch (error) {
      if (currentCompletionOwner(captured, owner, actor, stamp, id))
        setWriteError(
          `${error instanceof Error ? error.message : String(error)} Check this same operation before taking another action.`,
        );
    } finally {
      issuing.current = false;
      if (currentCompletionOwner(captured, owner, actor, stamp, id))
        setSending(false);
      journal.refresh();
    }
  };
  const busy = sending || pending;
  return (
    <section
      className="ntt-run ntt-stack"
      data-new-thread-templates-form={
        ready && session.status === "ready" && context.value !== null
          ? "usable"
          : "recovery"
      }
    >
      <div className="ntt-row ntt-between">
        <button
          type="button"
          className="ntt-link"
          disabled={sending || openingEditor}
          onClick={onBack}
        >
          ‹ All templates
        </button>
        <h3 className="ntt-selected-name" tabIndex={-1} ref={heading}>
          <TemplatePurposeIcon templateId={template.templateId} />
          {template.definition.name}
        </h3>
        <div className="ntt-row">
          <button
            type="button"
            className="ntt-link"
            onClick={onEdit}
            disabled={sending || openingEditor}
          >
            Edit
          </button>
          <button
            type="button"
            className="ntt-link"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            {details ? "Hide details" : "Details"}
          </button>
        </div>
      </div>
      {snapshot.status === "blocked" && (
        <div className="ntt-alert" role="alert">
          {snapshot.message}
          <div className="ntt-row">
            {snapshot.reason === "conflict" && snapshot.conflict && (
              <>
                <button
                  type="button"
                  className="ntt-button"
                  onClick={() => {
                    const owner = binding?.currentOwnerSession();
                    if (owner && snapshot.conflict)
                      void binding?.resolveConflict(
                        owner,
                        snapshot.conflict.token,
                        { kind: "accept-remote" },
                      );
                  }}
                >
                  Use saved inputs
                </button>
                <button
                  type="button"
                  className="ntt-button"
                  disabled={readonly}
                  onClick={() => {
                    const owner = binding?.currentOwnerSession();
                    if (owner && snapshot.conflict)
                      void binding?.resolveConflict(
                        owner,
                        snapshot.conflict.token,
                        { kind: "rebase", value: snapshot.conflict.local },
                      );
                  }}
                >
                  Keep my inputs
                </button>
              </>
            )}
            {
              <button
                type="button"
                className="ntt-button"
                onClick={() =>
                  void recoveryCommand(
                    "review",
                    (captured, owner) => captured.recoveryCandidates(owner),
                    (value) => setRecovery({ ok: true, value }),
                  )
                }
              >
                Review recovery drafts
              </button>
            }
            <button
              type="button"
              className="ntt-button"
              onClick={() =>
                void recoveryCommand("reconnect", (captured, owner) =>
                  captured.reconnect(owner),
                )
              }
            >
              Reconnect inputs
            </button>
          </div>
        </div>
      )}
      {recoveryFailure && (
        <div className="ntt-alert" role="alert">
          {recoveryFailure.message}
        </div>
      )}
      {recovery && !recovery.ok && (
        <div className="ntt-alert" role="alert">
          {recovery.error.message}
        </div>
      )}
      {recovery?.ok &&
        recovery.value.map((candidate) => (
          <div
            className="ntt-status"
            key={`${candidate.draft.key.ownerSession}:${candidate.revision}`}
          >
            <p>
              Saved unfinished inputs (
              {Object.keys(candidate.draft.desired.inputs).length} fields)
            </p>
            <button
              type="button"
              className="ntt-button"
              onClick={() =>
                void recoveryCommand(
                  "restore",
                  (captured, owner) => captured.recover(owner, candidate),
                  () => setRecovery(null),
                )
              }
            >
              Restore inputs
            </button>
            <button
              type="button"
              className="ntt-button"
              onClick={() =>
                void recoveryCommand(
                  "discard",
                  async (captured, owner) => {
                    const result = await captured.discardRecovery(
                      owner,
                      candidate,
                    );
                    return result.ok
                      ? captured.recoveryCandidates(owner)
                      : result;
                  },
                  (value) => setRecovery({ ok: true, value }),
                )
              }
            >
              Discard this recovery draft
            </button>
          </div>
        ))}
      {operation?.phase === "succeeded" &&
        operation.threadId &&
        (!operationId || operationId === operation.operationId) && (
          <div className="ntt-row ntt-status" role="status">
            <span>
              Thread started.{pending ? " Finishing saved inputs…" : ""}
            </span>
            <button
              type="button"
              className="ntt-link"
              onClick={() => {
                const live = client.currentSession();
                if (
                  !readonly &&
                  live.ok &&
                  live.value.status === "ready" &&
                  live.value.actor.identity.key === operation.actor.key
                )
                  navigate.toThread(operation.threadId!);
              }}
            >
              Open thread
            </button>
          </div>
        )}
      {operation?.sampleCapture?.state === "unavailable" && (
        <p className="ntt-help" role="status">
          Thread started. Recent sample could not be saved:{" "}
          {operation.sampleCapture.message}
        </p>
      )}
      {operation?.phase === "succeeded" &&
        operation.assignment &&
        (!operationId || operationId === operation.operationId) && (
          <AssignmentResult key={operation.operationId} status={operation} />
        )}
      {writeError && (
        <div className="ntt-alert" role="alert">
          {writeError}
        </div>
      )}
      {journal.error && (
        <div className="ntt-alert" role="alert">
          Launch status is unavailable: {journal.error} This operation will not
          be resent.
        </div>
      )}
      {context.error && (
        <div className="ntt-alert" role="alert">
          Destination choices could not refresh: {context.error}
        </div>
      )}
      {preview.error && (
        <div className="ntt-alert" role="alert">
          Final launch details are unavailable: {preview.error}
        </div>
      )}
      {nativeVisited && ownsNative && nativeOrigin && ready && (
        <div className="ntt-native-region" hidden={!nativeMode || pending}>
          <NativeTemplateEditor
            key={nativeOrigin.editorDraftId}
            draftKey={nativeEditorDraftKey(
              nativeOrigin.instanceId,
              nativeOrigin.actor,
              nativeOrigin.templateId,
              nativeOrigin.revision,
              nativeOrigin.editorDraftId,
            )}
            seed={publicNativeSeed(nativeOrigin.seed)}
            revision={nativeOrigin.revision}
            renderContext={nativeOrigin.renderContext}
            reopened={
              !createdEditors.current.has(nativeOrigin.editorDraftId) ||
              interruptedEditors.current.has(nativeOrigin.editorDraftId)
            }
            replacedInAnotherView={
              !!acknowledgedNativeOrigin &&
              acknowledgedNativeOrigin.editorDraftId !==
                nativeOrigin.editorDraftId &&
              !openingEditor
            }
            originChanged={
              nativeOrigin.revision !== template.revision ||
              JSON.stringify(nativeOrigin.inputs) !== JSON.stringify(inputs) ||
              (nativeOrigin.projectId ?? "") !== chosen ||
              JSON.stringify(nativeOrigin.renderContext) !==
                JSON.stringify(renderContext)
            }
            onSubmit={submitNative}
            onBack={() => setNativeMode(false)}
            onReset={() => void openNative(true)}
          />
        </div>
      )}
      <form
        hidden={nativeMode && !pending}
        ref={form}
        noValidate
        className="ntt-stack ntt-direct-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <InputFields
          definition={template.definition}
          inputs={inputs}
          onChange={changeInputs}
          disabled={!ready || busy}
          issues={issues}
        />
        {template.definition.destination.kind === "choose-at-launch" &&
          context.value && (
            <ProjectSelect
              context={context.value}
              value={chosen}
              onChange={changeProject}
              disabled={!ready || busy}
            />
          )}
        {issues
          .filter(
            (i) => !template.definition.fields.some((f) => f.key === i.path),
          )
          .map((i, index) => (
            <p
              className="ntt-error"
              role="alert"
              key={index}
              tabIndex={-1}
              data-form-error
            >
              {i.message}
            </p>
          ))}
        <RenderClock
          context={
            pending
              ? (savedCheckpoint?.request.renderContext ??
                operation?.renderContext ??
                renderContext)
              : renderContext
          }
          disabled={!ready || busy || pending}
          onRefresh={pending ? undefined : refreshTime}
        />
        {effective && !details && (
          <EffectsSummary effects={effective} compact />
        )}
        {!effective &&
          currentPreview?.issues
            .filter(
              (issue) =>
                !template.definition.fields.some(
                  (field) => field.key === issue.path,
                ) && issue.path !== "projectId",
            )
            .map((issue, index) => (
              <p className="ntt-error" key={index}>
                {issue.message}
              </p>
            ))}
        {personal?.nativeOperation && pending && (
          <p className="ntt-status">
            Edited with BB. The saved request keeps its actual destination and
            run settings; the form below remains your original template work.
          </p>
        )}
        {details && (
          <div className="ntt-stack">
            {effective && <EffectsSummary effects={effective} />}
            {effective?.warnings.map((w, i) => (
              <p className="ntt-help" key={i}>
                {w}
              </p>
            ))}
            <p className="ntt-help">
              Published revision{" "}
              {receipt?.revision.revision ?? template.revision} ·{" "}
              {effective?.createsProject
                ? "Creates a project, then starts one thread."
                : "Starts one thread in the destination project."}
            </p>
            <div>
              <strong>Thread title</strong>
              <pre className="ntt-preview">
                {effective?.title ?? "Complete the form to resolve the title."}
              </pre>
            </div>
            <div>
              <strong>First message</strong>
              <pre className="ntt-preview">
                {effective?.prompt ??
                  "Complete the form to resolve the first message."}
              </pre>
            </div>
          </div>
        )}
        {pending && noDispatch.current.has(operationId!) ? (
          <p className="ntt-status" role="status">
            Not sent. Reconnect inputs to return to your draft.
          </p>
        ) : (
          pending &&
          operation?.phase !== "succeeded" && (
            <div className="ntt-status" role="status">
              <p>
                {operation?.message ?? "Checking the saved launch operation…"}
              </p>
              {operation?.candidate && (
                <p>
                  A native row is {operation.candidate.state}; thread acceptance
                  is not yet confirmed.
                </p>
              )}
              {operation?.projectId && (
                <p>Prepared project: {operation.projectId}</p>
              )}
              <p>
                {operation?.phase === "failed" ||
                operation?.phase === "rejected"
                  ? "Your inputs and any prepared project are retained."
                  : "A pending or unknown operation is checked without resending."}
              </p>
              <button
                type="button"
                className="ntt-button"
                disabled={checking}
                onClick={() => void check()}
              >
                Check launch status
              </button>
              {!operation &&
                !journal.loading &&
                !journal.error &&
                journal.value?.id === operationId &&
                (savedCheckpoint?.request.operationId === operationId ? (
                  <>
                    <p>
                      Resume the exact saved request. Any existing server effect
                      remains check-only.
                    </p>
                    <button
                      type="button"
                      className="ntt-button"
                      disabled={
                        sending ||
                        !ready ||
                        session.status !== "ready" ||
                        savedCheckpoint.request.expectedActor !==
                          session.actor.identity.key
                      }
                      onClick={() => void resumeSaved()}
                    >
                      Resume saved request
                    </button>
                  </>
                ) : (
                  <p>
                    The original request cannot be safely recovered from this
                    older checkpoint. Keep checking for its server receipt; your
                    inputs remain saved.
                  </p>
                ))}
              {operation?.phase === "failed" &&
                operation.retryable &&
                ready && (
                  <button
                    type="button"
                    className="ntt-button"
                    disabled={sending}
                    onClick={() => void retryPreparation()}
                  >
                    Retry preparation
                  </button>
                )}
              {(operation?.phase === "failed" ||
                operation?.phase === "rejected") &&
                ready && (
                  <button
                    type="button"
                    className="ntt-button"
                    onClick={() => {
                      const {
                        operationId: _id,
                        nativeOperation: _nativeOperation,
                        launchCheckpoint: _launchCheckpoint,
                        revision: _revision,
                        ...retained
                      } = personal!;
                      edit(retained);
                      setOperation(null);
                      setWriteError(null);
                    }}
                  >
                    Edit inputs for a new launch
                  </button>
                )}
            </div>
          )
        )}
        <div className="ntt-footer">
          {ready && !pending && (
            <div className="ntt-stack">
              <div>
                <button
                  type="button"
                  className="ntt-link"
                  disabled={
                    openingEditor ||
                    (!ownsNative && !currentPreview?.nativeSeed)
                  }
                  onClick={() => void openNative()}
                >
                  {ownsNative ? "Resume BB editor" : "Edit with BB"}
                </button>
              </div>
              {!currentPreview?.nativeSeed &&
                template.definition.destination.kind === "new-project" &&
                !ownsNative && (
                  <p className="ntt-help">
                    BB editor is available for existing projects. This template
                    creates its project when sent.
                  </p>
                )}
            </div>
          )}
          <button
            type="submit"
            className="ntt-button ntt-primary ntt-send"
            aria-label="Start thread"
            title="Start thread (Cmd/Ctrl + Enter)"
            disabled={!ready || busy}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 4v9a4 4 0 0 1-4 4H5m5-5-5 5 5 5" />
            </svg>
          </button>
        </div>
        {snapshot.status === "ready" && (snapshot.saving || snapshot.dirty) && (
          <p className="ntt-help" role="status">
            Saving personal inputs…
          </p>
        )}
        {(snapshot.status === "waiting-for-identity" ||
          snapshot.status === "loading") && (
          <p className="ntt-help" role="status">
            Loading personal inputs…
          </p>
        )}
      </form>
    </section>
  );
}
