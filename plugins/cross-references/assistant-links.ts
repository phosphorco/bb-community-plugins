import { marked } from "marked";
import { canonicalizeResource, serializeResource, threadResource, type Resource } from "./canonical.ts";
import type { ObservedReference } from "./store.ts";

export type AssistantMessage = { text: string; createdAt: number };
export type LinkCandidate = { url: string; label: string; lastSeenAt: number };
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function assistantLinkLabel(value: string, fallback: string): string {
  const cleaned = value.normalize("NFC").replace(/\bhttps?:\/\/[^\s<>()]+/giu, "link").replace(/\p{Cc}/gu, " ").replace(/[`*_~]/g, "").trim() || fallback;
  const encoder = new TextEncoder();
  let result = "";
  for (const character of cleaned) {
    if (encoder.encode(result + character).length > 256) break;
    result += character;
  }
  return result || "Link";
}

/** Use the existing exact URL validation, including credential rejection. */
export function webTarget(candidate: LinkCandidate): Resource | null {
  try {
    const parsed = new URL(candidate.url);
    parsed.username = "";
    parsed.password = "";
    return serializeResource(canonicalizeResource({
      provider: "url", keys: { href: parsed.href },
      presentation: { label: assistantLinkLabel(candidate.label, parsed.host), detail: parsed.host, url: parsed.href },
    }));
  } catch { return null; }
}

export function localThreadTarget(url: string, appUrl?: string): { projectId: string; threadId: string } | null {
  try {
    const local = url.startsWith("/") && !url.startsWith("//");
    const parsed = new URL(url, local ? "https://local.invalid" : undefined);
    if (!local && (appUrl === undefined || parsed.origin !== new URL(appUrl).origin)) return null;
    const match = /^\/projects\/([^/]+)\/threads\/([^/]+)\/?$/.exec(parsed.pathname);
    if (match === null) return null;
    const projectId = decodeURIComponent(match[1]!);
    const threadId = decodeURIComponent(match[2]!);
    return ID.test(projectId) && ID.test(threadId) ? { projectId, threadId } : null;
  } catch { return null; }
}

export function extractAssistantLinkCandidates(messages: readonly AssistantMessage[]): LinkCandidate[] {
  const found = new Map<string, LinkCandidate>();
  for (const message of messages) {
    if (!Number.isSafeInteger(message.createdAt) || message.createdAt < 0 || message.createdAt > 8_640_000_000_000_000) continue;
    marked.walkTokens(marked.lexer(message.text), (token) => {
      if (token.type !== "link") return;
      const candidate = { url: token.href, label: token.text, lastSeenAt: message.createdAt };
      const target = webTarget(candidate);
      if (target !== null) candidate.url = target.keys.href!;
      else if (localThreadTarget(candidate.url) === null) return;
      const previous = found.get(candidate.url);
      if (previous === undefined || previous.lastSeenAt <= candidate.lastSeenAt) found.set(candidate.url, candidate);
    });
  }
  return [...found.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.url.localeCompare(b.url));
}

export async function resolveAssistantLinks(
  candidates: readonly LinkCandidate[],
  getThread: (threadId: string) => Promise<{ id: string; projectId: string; deletedAt?: number | null }>,
  appUrl?: string,
): Promise<ObservedReference[]> {
  const unique = new Map<string, ObservedReference>();
  // Resolve only enough candidates to fill one protocol-bounded projection.
  for (const candidate of candidates) {
    let target = webTarget(candidate);
    const local = localThreadTarget(candidate.url, appUrl);
    if (local !== null) {
      try {
        const thread = await getThread(local.threadId);
        if (thread.id === local.threadId && thread.projectId === local.projectId && thread.deletedAt == null) {
          target = threadResource(local.projectId, local.threadId, {
            label: assistantLinkLabel(candidate.label, "Thread"), detail: "BB thread",
            url: `/projects/${local.projectId}/threads/${local.threadId}`,
          });
        }
      } catch { /* Keep an absolute web fallback if verification is unavailable. */ }
    }
    if (target === null) continue;
    const key = canonicalizeResource(target).canonicalIdentityJson;
    if (!unique.has(key)) unique.set(key, { target, lastSeenAt: candidate.lastSeenAt });
    if (unique.size === 256) break;
  }
  return [...unique.values()];
}
