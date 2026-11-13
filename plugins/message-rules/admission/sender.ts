import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { groupGate } from "../evaluation/scoped.ts";
import { actionOf, match, usesJev, type Capture, type Rule, type RuleGroup } from "../contracts/model.ts";

/** Synchronous by design: native dispatch holds a server-wide lock. */
export function decideSenderMessage(
  context: MessageDispatchHookContext,
  policy: { groups: RuleGroup[]; rules: Rule[] },
): MessageDispatchHookDecision {
  const candidate: Capture = {
    projectId: context.project.id, projectTitle: context.project.name,
    message: context.input.text, senderTitle: null,
    destinationTitle: context.thread.title ?? context.thread.titleFallback ?? null,
    provenance: { senderId: context.senderThreadId === "mixed" ? null : context.senderThreadId, destinationId: context.thread.id },
    sender: { events: [], coverage: "unavailable", through: null },
    destination: { events: [], coverage: "unavailable", through: null },
  };
  const gate = groupGate(candidate, policy.groups, policy.rules);
  const unclear = gate.groups.find(group => group.status === "scope-unavailable" && policy.rules.some(rule => rule.enabled && rule.groupId === group.id));
  if (unclear) return { action: "reject", message: `Message Rules could not determine the scope of “${unclear.title}”. Use project/thread IDs rather than unavailable sender titles, or disable that rule group.` };
  for (const rule of [...gate.rules].sort((a,b) => a.order-b.order || a.id.localeCompare(b.id))) {
    const applies = match(rule.match, candidate);
    if (applies === false) continue;
    if (applies === null) return { action: "reject", message: `Message Rules could not check “${rule.title}”: required sender metadata is unavailable at dispatch. Change its predicate to use known project/thread IDs, or disable it.` };
    if (usesJev(rule)) return { action: "reject", message: `Message Rules cannot run the paid JEV check “${rule.title}” in the native sender hook. Disable that live rule or use an always-check rule. Saved JEV tests remain available; this message was not sent.` };
    const action = actionOf(rule);
    if (action === "reject") return { action: "reject", message: `${rule.title}: ${rule.advice}` };
    if (action !== "proceed") return { action: "reject", message: `Message Rules “${rule.title}” requests ${action}, which this sender hook does not implement. Use accept/reject rules or disable this rule; this message was not sent.` };
  }
  return { action: "proceed" };
}
