// Relevant public SDK event shapes captured from thr_tn5pxvdf7j. The command
// output body is intentionally represented only by its exact byte length: the
// fork-free projection retains output metadata, never output content.
const threadId = "thr_tn5pxvdf7j";
const command = "/usr/bin/zsh -lc \"sed -n '1,999p' /home/ubuntu/bb/.agents/skills/bb-performant-react/SKILL.md\nsed -n '1,999p' /home/ubuntu/bb/.agents/skills/bb-performant-react/references/performance-playbook.md\"";

export const catalogSnapshot = {
  version: 1,
  snapshotId: "sdk-snapshot-thr-tn5pxvdf7j",
  capturedAtMs: 1789751300000,
  projectId: "proj_t8x9yhwnvc",
  environmentId: "env_tqsfutmr8b",
  source: "sdk.skills.list/getContent/listFiles",
  entries: [{
    skillId: "skill_9abda8e8ba47ab3ce5e3de59fcd54476b9c02ce801d3519f2a2aedcbbd30df52",
    name: "bb-performant-react",
    provider: "codex",
    scope: "provider-project",
    pluginId: null,
    filePath: "/home/ubuntu/bb/.agents/skills/bb-performant-react/SKILL.md",
    contentRevision: "9f96984c438da69afea434f07f9a32e9e47c29b488ca33f9c0b2b58de378bc0d",
    contentBytes: 6379,
    registeredPaths: [
      "/home/ubuntu/bb/.agents/skills/bb-performant-react/SKILL.md",
      "/home/ubuntu/bb/.agents/skills/bb-performant-react/references/performance-playbook.md",
    ],
    filesTruncated: false,
  }, {
    skillId: "skill_provider_neutral_fixture",
    name: "provider-neutral-fixture",
    provider: null,
    scope: "bb-project",
    pluginId: null,
    filePath: "/home/ubuntu/bb/.agents/skills/provider-neutral-fixture/SKILL.md",
    contentRevision: "b".repeat(64),
    contentBytes: 1,
    registeredPaths: ["/home/ubuntu/bb/.agents/skills/provider-neutral-fixture/SKILL.md"],
    filesTruncated: false,
  }],
};

export const probeEvents = [
  {
    id: "evt_34xvtzvafb", scope: { kind: "thread" }, threadId, seq: 1, createdAt: 1789751254367, type: "client/turn/requested",
    data: {
      direction: "outbound", requestId: "creq_4knsimhmfm", source: "spawn", initiator: "user", senderThreadId: null,
      systemMessageKind: "unlabeled", systemMessageSubject: null,
      input: [{ type: "text", text: "This is a read-only telemetry experiment. Explicitly use the $bb-performant-react skill through the normal Codex skill workflow: announce that you are using it, load and read its SKILL.md completely, and read only the directly required reference it points to for a minimal review of the Analytics Skills screen. Do not edit any files, do not run tests, and do not spawn children. After loading the skill, report: (1) the exact skill name, (2) the exact SKILL.md path read, (3) any directly required reference path read, and (4) a single sentence confirming completion. Send an early message and final result to parent thread thr_wtfya9updp using bb thread tell. This probe is specifically meant to inspect what unmodified BB already retains for a Codex skill access.", mentions: [] }],
      target: { kind: "thread-start" }, request: { method: "thread/start", params: {} },
      execution: { model: "gpt-5.6-terra", serviceTier: "fast", reasoningLevel: "high", permissionMode: "auto", source: "client/turn/requested" },
    },
  },
  {
    id: "evt_ktrynhdkme", scope: { kind: "turn", turnId: "daae0c0a24-t6" }, threadId, seq: 32, createdAt: 1789751270099, type: "item/started",
    data: { providerThreadId: "01a0b57c-eefc-79b2-bf81-d7bf238bdce4", item: { type: "commandExecution", id: "daae0c0a24-i162", command, cwd: "/home/ubuntu/bb", status: "pending", approvalStatus: null, presentation: { label: { pending: "Running command", completed: "Ran command" }, icon: { glyph: "Terminal" }, title: "sed -n '1,999p' /home/ubuntu/bb/.agents/skills/bb-performant-react/SKILL.md" } } },
  },
  {
    id: "evt_nn5dyxhzbj", scope: { kind: "turn", turnId: "daae0c0a24-t6" }, threadId, seq: 33, createdAt: 1789751270099, type: "item/completed",
    data: { providerThreadId: "01a0b57c-eefc-79b2-bf81-d7bf238bdce4", item: { type: "commandExecution", id: "daae0c0a24-i162", command, cwd: "/home/ubuntu/bb", status: "completed", approvalStatus: null, aggregatedOutput: "x".repeat(17283), exitCode: 0, durationMs: 0, presentation: { label: { pending: "Running command", completed: "Ran command" }, icon: { glyph: "Terminal" }, title: "sed -n '1,999p' /home/ubuntu/bb/.agents/skills/bb-performant-react/SKILL.md" } } },
  },
];

export const activeCapture = { captureId: "capture-thr-tn5pxvdf7j", trigger: "thread.active", capturedAtMs: 1789751300000, completeness: "complete", error: null, snapshot: catalogSnapshot };
