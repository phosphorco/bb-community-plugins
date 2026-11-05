/** Synthetic native catalog/launch responses; real public identity binding and controller wire. */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { idCodec } from "@phosphorco/bb-identity/model";
import { createIdentityWireFake } from "@phosphorco/bb-identity/testing";
import {
  inputDraftResource,
  createRenderContext,
  type RenderContext,
  type InvocationSample,
  starterDefinitions,
  legacyGenericStarterDefinitions,
  validateDefinition,
  validateInputs,
  renderText,
  type TemplateEntry,
  type TemplateDefinition,
  type PersonalDraft,
} from "../model.ts";
import {
  templatesContract,
  type TemplatesContext,
  type ResolvedEffects,
  type LaunchRequest,
  type LaunchStatus,
  type RecentLaunch,
  type RemoveRequest,
  type TemplateRemoval,
  type AssignmentStatus,
  type TargetPreviewRequest,
} from "../rpc-contract.ts";

export async function appFixture(instanceId = "templates-app-instance") {
  const host = createFakePluginHost({ pluginId: "new-thread-templates" });
  const wire = createIdentityWireFake({
    host,
    mode: "multi-user",
    instanceId,
    resource: inputDraftResource,
    policy: { kind: "self-only" },
    readPolicy: { kind: "collaborators" },
    actor: { subject: "ada", name: "Ada Fixture" },
  });
  wire.addPerson({ subject: "bea", name: "Bea Fixture" });
  let entries: TemplateEntry[] = starterDefinitions().map((definition, i) => ({
    id: definition.id,
    draft: {
      templateId: definition.id,
      generation: 1,
      definition,
      editedAt: 1,
      editedBy: { key: "fixture:ada", name: "Ada Fixture" },
    },
    published:
      definition.destination.kind === "new-project"
        ? null
        : {
            templateId: definition.id,
            revision: 1,
            definition,
            publishedAt: 1,
            publishedBy: { key: "fixture:ada", name: "Ada Fixture" },
          },
    latestRevision: definition.destination.kind === "new-project" ? 0 : 1,
  }));
  const samples = new Map<string, InvocationSample[]>();
  const receipts = new Map<string, RecentLaunch>();
  const removed = new Map<
    string,
    { request: RemoveRequest; receipt: TemplateRemoval }
  >();
  const holds = new Map<string, Promise<void>>();
  const calls: { method: string; input: unknown }[] = [],
    launches = new Map<string, LaunchStatus>();
  const flags = {
    catalogError: false,
    contextError: false,
    previewError: false,
    samplesError: false,
    saveError: false,
    launchMode: "success" as "success" | "unknown" | "failed" | "lost",
    launchCount: 0,
    statusError: false,
    recentPageSize: 50,
    assignmentCheckError: false,
    assignmentRetryError: false,
    assignment: undefined as AssignmentStatus | undefined,
    assignmentRetryResult: undefined as AssignmentStatus | undefined,
  };
  const context: TemplatesContext = {
    primaryHostId: "host-primary",
    projects: [
      {
        id: "project-a",
        name: "Fixture project",
        sources: [
          { hostId: "host-a", path: "/workspace/fixture", isDefault: true },
        ],
      },
      {
        id: "project-b",
        name: "Second fixture project",
        sources: [
          { hostId: "host-b", path: "/workspace/second", isDefault: true },
        ],
      },
    ],
    hosts: [
      { id: "host-a", name: "Fixture machine", online: true },
      { id: "host-b", name: "Second fixture machine", online: true },
    ],
    environments: [
      {
        id: "env-a",
        projectId: "project-a",
        hostId: "host-a",
        name: "Feature worktree",
        path: "/workspace/fixture-feature",
      },
    ],
    models: [
      {
        providerId: "provider-a",
        model: "model-a",
        label: "Fixture model",
        reasoningLevels: ["medium", "high"],
        serviceTiers: [],
      },
    ],
    actor: { key: "fixture:ada", name: "Ada Fixture" },
    session: "fixture-session",
    warnings: [],
  };
  const effects = (
    definition: TemplateDefinition,
    inputs: Record<string, string | number | boolean>,
    projectId?: string,
    renderContext?: RenderContext,
  ): ResolvedEffects => {
    const d = definition.destination,
      pid =
        d.kind === "existing-project"
          ? d.projectId
          : (projectId ?? "project-a"),
      project =
        context.projects.find((p) => p.id === pid) ?? context.projects[0]!;
    const source =
      d.kind !== "new-project" && d.hostId
        ? project.sources.find((source) => source.hostId === d.hostId)
        : project.sources[0];
    if (
      d.kind !== "new-project" &&
      d.hostId &&
      (!source ||
        !context.hosts.some((host) => host.id === d.hostId && host.online))
    )
      throw new Error("The selected machine has no available project source");
    const targetHost = d.kind === "new-project" ? d.hostId : source!.hostId;
    return {
      ...(renderContext ? { renderContext } : {}),
      projectId: d.kind === "new-project" ? null : project.id,
      projectName:
        d.kind === "new-project"
          ? renderText(d.nameTemplate, inputs, undefined, renderContext)
          : project.name,
      hostId: targetHost,
      hostName:
        context.hosts.find((host) => host.id === targetHost)?.name ??
        targetHost,
      path: d.kind === "new-project" ? d.path : source!.path,
      nativeEnvironment: {
        type: "host",
        hostId: targetHost,
        workspace: {
          type: "unmanaged",
          path: d.kind !== "new-project" && d.hostId ? source!.path : null,
        },
      },
      environment:
        d.environment.kind === "reuse"
          ? "Feature worktree"
          : "Project checkout",
      createsProject: d.kind === "new-project",
      routing:
        d.environment.kind === "reuse"
          ? { kind: "environment", environmentId: d.environment.environmentId }
          : { kind: "host", hostId: targetHost },
      execution: {
        providerId:
          definition.execution.kind === "explicit"
            ? definition.execution.providerId
            : "provider-a",
        model:
          definition.execution.kind === "explicit"
            ? definition.execution.model
            : "model-a",
        reasoningLevel: "medium",
        serviceTier: null,
        permissionMode: "auto",
        inherited: definition.execution.kind === "project-default",
      },
      title: renderText(
        definition.titleTemplate,
        inputs,
        undefined,
        renderContext,
      ),
      prompt: renderText(
        definition.promptTemplate,
        inputs,
        undefined,
        renderContext,
      ),
      warnings: [],
    };
  };
  const configListeners = new Map<string, Set<() => void>>();
  const sdk = {
    subscribe({
      event,
      callback,
    }: {
      event: string;
      callback: (...args: any[]) => void;
    }) {
      const listeners = configListeners.get(event) ?? new Set<() => void>();
      configListeners.set(event, listeners);
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  let catalogVersion = 0,
    publishedSignature = "";
  const catalogId = crypto.randomUUID();
  const methods = {
    publishedCatalog() {
      if (flags.catalogError)
        throw new Error("Catalog temporarily unavailable");
      const revisions = entries.flatMap((entry) =>
        entry.published ? [structuredClone(entry.published)] : [],
      );
      const signature = JSON.stringify(revisions);
      if (signature !== publishedSignature) {
        publishedSignature = signature;
        catalogVersion++;
      }
      return { instanceId, catalogId, version: catalogVersion, revisions };
    },
    choices() {
      if (flags.contextError)
        throw new Error("Context temporarily unavailable");
      const { projects, hosts, environments, primaryHostId, warnings } =
        context;
      return { projects, hosts, environments, primaryHostId, warnings };
    },
    targetPreview(input: TargetPreviewRequest) {
      if (flags.previewError)
        throw new Error("Preview temporarily unavailable");
      const destination =
        input.destination.kind === "new-project"
          ? { ...input.destination, nameTemplate: "Fixture project" }
          : input.destination;
      const definition = {
        ...starterDefinitions()[0]!,
        destination,
        execution: input.execution,
        fields: [],
        titleTemplate: "",
        promptTemplate: "fixture",
      };
      const issues = validateDefinition(definition).filter(
        (issue) =>
          issue.path.startsWith("destination") ||
          issue.path.startsWith("execution"),
      );
      if (issues.length) return { issues, effects: null };
      try {
        const { title, prompt, renderContext, ...resolved } = effects(
          definition,
          {},
          input.projectId,
        );
        if (input.destination.kind === "new-project")
          resolved.projectName = input.destination.name;
        return { issues: [], effects: resolved };
      } catch (error) {
        return {
          issues: [
            {
              path: "destination",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          effects: null,
        };
      }
    },
    recentSamples({ templateId }: { templateId: string }) {
      if (flags.samplesError)
        throw new Error("Samples temporarily unavailable");
      return {
        samples: structuredClone(
          samples.get(`${wire.actor!.identity.key}:${templateId}`) ?? [],
        ).slice(0, 5),
      };
    },
    recentLaunches({ offset = 0 }: { offset?: number }) {
      const rows = [...launches.values()].sort(
        (a, b) =>
          b.createdAt - a.createdAt ||
          a.operationId.localeCompare(b.operationId),
      );
      return {
        launches: rows
          .slice(offset, offset + flags.recentPageSize)
          .map((status) => ({ ...receipts.get(status.operationId)!, status })),
        nextOffset:
          rows.length > offset + flags.recentPageSize
            ? offset + flags.recentPageSize
            : null,
      };
    },
    catalog() {
      if (flags.catalogError)
        throw new Error("Catalog temporarily unavailable");
      return { entries };
    },
    context() {
      if (flags.contextError)
        throw new Error("Context temporarily unavailable");
      return context;
    },
    remove(input: RemoveRequest) {
      const previous = removed.get(input.templateId);
      if (
        previous &&
        JSON.stringify(previous.request) === JSON.stringify(input)
      )
        return previous.receipt;
      const entry = entries.find((e) => e.id === input.templateId);
      if (
        !entry ||
        (entry.draft?.generation ?? null) !== input.expectedGeneration ||
        (entry.published?.revision ?? null) !== input.expectedRevision ||
        entry.latestRevision !== input.expectedLatestRevision
      )
        throw new Error("Template changed; reload before removing");
      entries = entries.filter((e) => e.id !== input.templateId);
      const receipt = {
        templateId: input.templateId,
        removedAt: 4,
        removedBy: context.actor,
      };
      removed.set(input.templateId, {
        request: structuredClone(input),
        receipt,
      });
      return receipt;
    },
    saveDraft(input: {
      definition: TemplateDefinition;
      expectedGeneration: number | null;
    }) {
      if (flags.saveError) throw new Error("Shared draft write failed");
      if (removed.has(input.definition.id))
        throw new Error("Removed template ID is reserved");
      const entry = entries.find((e) => e.id === input.definition.id);
      if ((entry?.draft?.generation ?? null) !== input.expectedGeneration)
        throw new Error("Shared draft changed; reload before saving");
      const draft = {
        templateId: input.definition.id,
        generation: (entry?.draft?.generation ?? 0) + 1,
        definition: input.definition,
        editedAt: 2,
        editedBy: context.actor,
      };
      if (entry) entry.draft = draft;
      else
        entries.push({
          id: draft.templateId,
          draft,
          published: null,
          latestRevision: 0,
        });
      return draft;
    },
    publish(input: { templateId: string; expectedGeneration: number }) {
      const entry = entries.find((e) => e.id === input.templateId)!;
      const issues = validateDefinition(entry.draft!.definition);
      if (!issues.length) {
        entry.latestRevision++;
        entry.published = {
          templateId: entry.id,
          revision: entry.latestRevision,
          definition: structuredClone(entry.draft!.definition),
          publishedAt: 3,
          publishedBy: context.actor,
        };
      }
      return { entry, issues };
    },
    duplicate(input: { templateId: string; newId: string }) {
      const entry = entries.find((e) => e.id === input.templateId)!;
      const definition = {
        ...structuredClone(
          entry.draft?.definition ?? entry.published!.definition,
        ),
        id: input.newId,
        name: `${entry.draft?.definition.name ?? entry.published!.definition.name} copy`,
      };
      return methods.saveDraft({ definition, expectedGeneration: null });
    },
    unpublish(input: { templateId: string }) {
      const entry = entries.find((e) => e.id === input.templateId)!;
      entry.published = null;
      return entry;
    },
    preview(input: {
      definition: TemplateDefinition;
      inputs: Record<string, string | number | boolean>;
      projectId?: string;
      renderContext?: RenderContext;
    }) {
      const renderContext =
        input.renderContext ??
        createRenderContext(input.definition.timeZone ?? "UTC");
      if (flags.previewError)
        throw new Error("Preview temporarily unavailable");
      const issues = [
        ...validateDefinition(input.definition),
        ...validateInputs(input.definition, input.inputs).issues,
      ];
      let resolved: ResolvedEffects | null = null;
      if (!issues.length) {
        try {
          resolved = effects(
            input.definition,
            input.inputs,
            input.projectId,
            renderContext,
          );
        } catch (error) {
          issues.push({
            path: "destination",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        renderContext,
        issues,
        effects: resolved,
        nativeSeed: resolved?.projectId
          ? {
              defaultProjectId: resolved.projectId,
              defaultProviderId: resolved.execution.providerId,
              defaultModel: resolved.execution.model,
              defaultReasoningLevel: "medium",
              defaultPermissionMode: "auto" as const,
              defaultEnvironment: {
                type: "host" as const,
                hostId: resolved.hostId!,
                workspace: {
                  type: "unmanaged" as const,
                  path:
                    input.definition.destination.kind !== "new-project" &&
                    input.definition.destination.hostId
                      ? resolved.path
                      : null,
                },
              },
              initialPrompt: resolved.prompt,
            }
          : null,
      };
    },
    launch(input: LaunchRequest) {
      flags.launchCount++;
      const status: LaunchStatus = {
        renderContext: input.renderContext ?? createRenderContext(),
        operationId: input.operationId,
        templateId: input.templateId,
        revision: input.revision,
        phase:
          flags.launchMode === "success"
            ? "succeeded"
            : flags.launchMode === "failed"
              ? "failed"
              : "indeterminate",
        projectId: input.projectId ?? "project-a",
        threadId: flags.launchMode === "success" ? "thread-confirmed" : null,
        message:
          flags.launchMode === "failed"
            ? "Preparation unavailable"
            : flags.launchMode === "success"
              ? "Thread started"
              : "Outcome unknown. Check receipt without resending.",
        retryable: flags.launchMode === "failed",
        actor: { key: input.expectedActor, name: "Ada Fixture" },
        inputs: input.inputs,
        nativeAttribution: "plugin-origin",
        createdAt: 1,
        updatedAt: 1,
        ...(flags.assignment
          ? {
              assignment: {
                ...structuredClone(flags.assignment),
                operationId: input.operationId,
                threadId: "thread-confirmed",
                actorKey: input.expectedActor,
              },
            }
          : {}),
      };
      launches.set(input.operationId, status);
      if (!receipts.has(input.operationId)) {
        const revision = entries.find(
          (e) => e.id === input.templateId,
        )!.published!;
        receipts.set(input.operationId, {
          status,
          ...(input.renderContext
            ? {
                requestedRenderContext: structuredClone(input.renderContext),
                renderContext: structuredClone(input.renderContext),
              }
            : {}),
          revision: structuredClone(revision),
          ...(input.projectId ? { requestedProjectId: input.projectId } : {}),
          effects: effects(
            revision.definition,
            input.inputs,
            input.nativeSubmission?.projectId ?? input.projectId,
            status.renderContext,
          ),
          ...(input.nativeSubmission
            ? { nativeSubmission: structuredClone(input.nativeSubmission) }
            : {}),
        });
      }
      if (flags.launchMode === "lost") throw new Error("Response lost");
      return status;
    },
    launchStatus(input: { operationId: string }) {
      if (flags.statusError) throw new Error("Status temporarily unavailable");
      if (flags.assignmentCheckError)
        throw new Error("Assignment lookup unavailable");
      return launches.get(input.operationId) ?? null;
    },
    resumeLaunch(input: {
      checkpoint: import("../model.ts").LaunchCheckpoint;
      expectedActor: string;
      expectedSession: string;
    }): LaunchStatus {
      if (
        input.expectedActor !== input.checkpoint.request.expectedActor ||
        input.expectedActor !== wire.actor?.identity.key
      )
        throw new Error("Original launch actor required");
      const existing = launches.get(input.checkpoint.request.operationId);
      if (existing && existing.phase !== "failed") return existing;
      return methods.launch({
        ...input.checkpoint.request,
        expectedSession: input.expectedSession,
      });
    },
    retryAssignment(input: {
      operationId: string;
      expectedActor: string;
      expectedSession: string;
    }) {
      if (flags.assignmentRetryError)
        throw new Error("Assignment response lost");
      const previous = launches.get(input.operationId);
      if (!previous?.assignment) throw new Error("No assignment intent");
      if (
        input.expectedActor !== previous.assignment.actorKey ||
        input.expectedActor !== wire.actor?.identity.key
      )
        throw new Error("Original person required");
      const next = {
        ...previous,
        assignment: flags.assignmentRetryResult
          ? structuredClone(flags.assignmentRetryResult)
          : previous.assignment,
      };
      launches.set(input.operationId, next);
      return next;
    },
  };
  host.bb.rpc.register(templatesContract, methods);
  const handlers: Record<string, (input: any) => any> = { ...wire.rpc };
  for (const name of Object.keys(methods) as (keyof typeof methods)[]) {
    handlers[name] = async (raw: unknown) => {
      assertStrictJson(raw);
      calls.push({ method: name, input: structuredClone(raw) });
      const response = await host.harness.behavior.callRpc(name, raw);
      assertStrictJson(response);
      const held = holds.get(name);
      if (held) await held;
      return response;
    };
  }
  return {
    wire,
    sdk,
    emitConfig(event = "project:changed") {
      for (const callback of configListeners.get(event) ?? []) callback();
    },
    configSubscriptionCount() {
      return [...configListeners.values()].reduce(
        (count, listeners) => count + listeners.size,
        0,
      );
    },
    handlers,
    calls,
    flags,
    context,
    launches,
    seedSamples(
      templateId: string,
      records: InvocationSample[],
      actor = wire.actor!.identity.key,
    ) {
      samples.set(`${actor}:${templateId}`, structuredClone(records));
    },
    // Synthetic verified-person snapshot for UI eligibility tests only. The
    // shared wire/controller is real; this is not provider/native identity proof.
    useVerifiedAssignmentActor() {
      Object.assign(wire.actor!, { evidence: "provider-verified" });
    },
    seedRecent(count: number) {
      const base = structuredClone(
        entries.find((e) => e.id === "review-pr")!.published!,
      );
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID(),
          old = i === count - 1,
          revision = {
            ...structuredClone(base),
            definition: {
              ...structuredClone(base.definition),
              name: old
                ? "Historical unpublished review"
                : `Recent fixture ${i}`,
            },
          };
        const status: LaunchStatus = {
          operationId: id,
          templateId: revision.templateId,
          revision: revision.revision,
          phase: "indeterminate",
          projectId: "project-a",
          threadId: null,
          message: "Outcome unknown; check receipt only.",
          retryable: false,
          actor: { key: wire.actor!.identity.key, name: "Ada Fixture" },
          inputs: {
            subject: "Historic subject",
            pr_url: `https://example.test/pull/${i}`,
          },
          nativeAttribution: "plugin-origin",
          createdAt: count - i,
          updatedAt: count - i,
        };
        launches.set(id, status);
        receipts.set(id, {
          status,
          revision,
          requestedProjectId: "project-a",
          effects: effects(
            revision.definition,
            status.inputs,
            "project-a",
            status.renderContext,
          ),
        });
      }
      entries.find((e) => e.id === "review-pr")!.published = null;
    },
    personalAddress(templateId = "review-pr") {
      const instance = idCodec("instance").decode(instanceId);
      if (!instance.ok) throw new Error("fixture instance");
      return {
        instanceId: instance.value,
        pluginId: inputDraftResource.pluginId,
        collection: inputDraftResource.definition.collection,
        recordId: templateId,
        owner: wire.actor!.identity.key,
      };
    },
    async readPersonal(templateId = "review-pr") {
      const instance = idCodec("instance").decode(instanceId);
      if (!instance.ok) throw new Error("fixture instance");
      const read = await wire.storage.storage.read({
        instanceId: instance.value,
        pluginId: inputDraftResource.pluginId,
        collection: inputDraftResource.definition.collection,
        recordId: templateId,
        owner: wire.actor!.identity.key,
      });
      if (!read.ok) throw new Error(read.error.message);
      return read.value.status === "present" ? read.value.envelope.value : null;
    },
    seedPersonal(value: PersonalDraft, templateId = "review-pr") {
      const instance = idCodec("instance").decode(instanceId);
      if (!instance.ok) throw new Error("fixture instance");
      const address = {
        instanceId: instance.value,
        pluginId: inputDraftResource.pluginId,
        collection: inputDraftResource.definition.collection,
        recordId: templateId,
        owner: wire.actor!.identity.key,
      };
      wire.storage.seed({
        address,
        version: { epoch: "fixture-seed", sequence: 1 },
        schemaVersion: 1,
        value,
        lastEditedBy: wire.actor,
      });
    },
    seedReceipt(
      status: LaunchStatus,
      definition: TemplateEntry["published"],
      nativeSubmission?: LaunchRequest["nativeSubmission"],
      requestedRenderContext?: RenderContext,
    ) {
      if (!definition) throw new Error("fixture revision");
      launches.set(status.operationId, status);
      receipts.set(status.operationId, {
        status,
        revision: structuredClone(definition),
        ...(status.renderContext
          ? { renderContext: status.renderContext }
          : {}),
        ...(requestedRenderContext ? { requestedRenderContext } : {}),
        effects: effects(
          definition.definition,
          status.inputs,
          undefined,
          status.renderContext,
        ),
        ...(nativeSubmission ? { nativeSubmission } : {}),
      });
    },
    holdResponse(method: string) {
      let release!: () => void;
      holds.set(
        method,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        holds.delete(method);
        release();
      };
    },
    addLegacyFixtures() {
      for (const definition of legacyGenericStarterDefinitions())
        entries.push({
          id: definition.id,
          draft: {
            templateId: definition.id,
            generation: 1,
            definition,
            editedAt: 1,
            editedBy: context.actor,
          },
          published:
            definition.destination.kind === "new-project"
              ? null
              : {
                  templateId: definition.id,
                  revision: 1,
                  definition,
                  publishedAt: 1,
                  publishedBy: context.actor,
                },
          latestRevision: definition.destination.kind === "new-project" ? 0 : 1,
        });
    },
    get entries() {
      return entries;
    },
    effects,
    async dispose() {
      wire.dispose();
      await host.harness.lifecycle.dispose();
    },
  };
}

export function assertStrictJson(value: unknown, path = "$input"): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStrictJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value))
      assertStrictJson(item, `${path}.${key}`);
    return;
  }
  throw new Error(`RPC value at ${path} is not a JSON value`);
}
