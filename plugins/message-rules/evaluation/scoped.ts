import {
  match,
  type Capture,
  type Rule,
  type RuleGroup,
  type Evaluation,
  type Connection,
} from "../contracts/model.ts";
import { fingerprint } from "../contracts/hash.ts";
import { evaluate, type TokenCounter, type Transport } from "./evaluator.ts";

// Input is already-available routing metadata. Never fetch history to decide scope.
export type ScopeContext = Pick<
  Capture,
  | "projectId"
  | "projectTitle"
  | "senderTitle"
  | "destinationTitle"
  | "provenance"
>;
export function groupGate(
  context: ScopeContext,
  groups: RuleGroup[],
  rules: Rule[],
) {
  const cheap: Capture = {
    ...context,
    message: "",
    sender: { events: [], coverage: "unavailable", through: null },
    destination: { events: [], coverage: "unavailable", through: null },
  };
  const results: NonNullable<Evaluation["groups"]> = groups.map((g) => {
    const matches = g.enabled ? match(g.match, cheap) : false;
    return {
      id: g.id,
      title: g.title,
      revision: g.revision,
      status: !g.enabled
        ? "disabled"
        : matches === true
          ? "in-scope"
          : matches === false
            ? "outside-scope"
            : "scope-unavailable",
    };
  });
  const active = new Set(
    results.filter((g) => g.status === "in-scope").map((g) => g.id),
  );
  return {
    groups: results,
    rules: rules.filter((r) => r.enabled && active.has(r.groupId)),
  };
}
export async function evaluateScoped(
  context: ScopeContext,
  groups: RuleGroup[],
  rules: Rule[],
  config: Connection,
  capture: (rules: Rule[]) => Promise<Capture>,
  transport: Transport,
  signal: AbortSignal,
  counter?: TokenCounter,
): Promise<Evaluation> {
  const gate = groupGate(context, groups, rules);
  // Crucially: no capture callback and no transport for out-of-scope routing.
  const captured: Capture = gate.rules.length
    ? await capture(gate.rules)
    : {
        ...context,
        message: "",
        sender: { events: [], coverage: "unavailable", through: null },
        destination: { events: [], coverage: "unavailable", through: null },
      };
  const c: Capture = {
    ...captured,
    projectId: context.projectId ?? null,
    projectTitle: context.projectTitle ?? null,
  };
  const evaluated = await evaluate(
    c,
    gate.rules,
    config,
    transport,
    signal,
    counter,
  );
  const ids = new Set(gate.rules.map((r) => r.id));
  evaluated.rules.push(
    ...rules
      .filter((r) => r.enabled && !ids.has(r.id))
      .map((r) => ({
        id: r.id,
        title: r.title,
        revision: r.revision,
        status: "not-applicable" as const,
        reason:
          "Group gate: " +
          (gate.groups.find((g) => g.id === r.groupId)?.status ?? "unassigned"),
        observations: {},
      })),
  );
  evaluated.rules.sort(
    (a, b) =>
      (rules.find((r) => r.id === a.id)?.order ?? 0) -
        (rules.find((r) => r.id === b.id)?.order ?? 0) ||
      a.id.localeCompare(b.id),
  );
  evaluated.groups = gate.groups;
  evaluated.inputHash = fingerprint({
    version: evaluated.version,
    groups,
    context,
    evaluation: evaluated.inputHash,
  });
  if (
    gate.groups.some(
      (g) =>
        g.status === "scope-unavailable" &&
        rules.some((r) => r.enabled && r.groupId === g.id),
    )
  ) {
    evaluated.policy = "unknown";
    evaluated.errors.push(
      "A group scope requires unavailable project/thread metadata. No work ran for that group.",
    );
  }
  return evaluated;
}
