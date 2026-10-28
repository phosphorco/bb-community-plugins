import type { ResourceIdentity } from "./model.ts";

/** RPC resources already have canonical values; key insertion order is irrelevant. */
export function referenceIdentityKey(resource: ResourceIdentity): string {
  return JSON.stringify([resource.provider, Object.entries(resource.keys).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
}

/** Replace the whole row when a surviving producer reappears on a later page. */
export function mergeReferenceRows<Row>(
  previous: readonly Row[],
  incoming: readonly Row[],
  resourceFor: (row: Row) => ResourceIdentity,
): Row[] {
  const rows = new Map<string, Row>();
  for (const row of previous) rows.set(referenceIdentityKey(resourceFor(row)), row);
  for (const row of incoming) rows.set(referenceIdentityKey(resourceFor(row)), row);
  return [...rows.values()];
}

const GENERIC_LINK_LABELS = new Set([
  "", "link", "the link", "here", "see here", "this", "url", "click here", "this link", "link here", "this page",
  "read more", "more", "source",
]);
const MAX_LABEL_CHARS = 60;
// Control and format characters (bidi overrides, zero-width), except ZWJ which joins emoji sequences.
const UNSAFE_CHARS = /[\p{Cc}\u2028\u2029]|(?!\u200d)\p{Cf}/gu;
const LOCAL_BASE = "http://bb.invalid";

// `text` is null when generic link text has nothing better to show: the row
// then omits it rather than repeating "link". `note` is screen-reader text
// marking a derived label; `title` is the hover tooltip.
export type DisplayLabel = { text: string | null; derived: boolean; title: string | undefined; note: string | undefined };

// Re-encode rather than delete unsafe characters, so distinct URLs never collapse into one label.
function sanitize(value: string): string {
  return value.replace(UNSAFE_CHARS, (char) => encodeURIComponent(char));
}

function normalizeLabel(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/gu, " ").toLowerCase();
}

function hostAndPath(value: string): string {
  return value.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

// Labels that only restate the URL or host: the host is worth keeping in the derived text.
function restatesUrl(label: string, parsed: URL): boolean {
  const restated = hostAndPath(label.trim());
  if (restated === "" || parsed.origin === LOCAL_BASE) return false;
  const host = parsed.hostname.replace(/^www\./, "");
  return restated === host || restated === hostAndPath(`${parsed.host}${parsed.pathname}`) || restated === hostAndPath(parsed.href);
}

// Decode one segment, keeping reserved delimiters and literal % encoded so distinct URLs never look alike.
function decodeSegment(segment: string): string {
  try {
    return sanitize(decodeURIComponent(segment.replace(/%(2F|3F|23|25)/gi, "%25$1")));
  } catch {
    return segment;
  }
}

function truncateStart(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `…${chars.slice(-(max - 1)).join("")}`;
}

function readablePath(parsed: URL, withHost: boolean): string | null {
  const segments = parsed.pathname.split("/").map(decodeSegment);
  const hash = parsed.hash === "" ? "" : `#${decodeSegment(parsed.hash.slice(1))}`;
  const path = segments.join("/");
  if ((path === "/" || path === "") && hash === "" && !withHost) return null;
  const prefix = withHost ? parsed.host : "";
  const full = `${prefix}${path === "/" && hash === "" && withHost ? "" : path}${hash}`;
  if ([...full].length <= MAX_LABEL_CHARS) return full;
  // Keep the end of the path: the filename or id is what tells rows apart.
  const tail = `${segments.filter(Boolean).slice(-2).join("/")}${hash}`;
  return truncateStart(`…/${tail}`, MAX_LABEL_CHARS);
}

// Generic link text ("link", "here") says nothing; show the URL path the anchor hid instead.
// Query strings are left out: they are mostly tracking or token noise.
export function displayLabel(label: string, url: string | undefined): DisplayLabel {
  const authored = { text: label, derived: false, title: undefined, note: undefined };
  if (url == null) return authored;
  let parsed: URL;
  try {
    parsed = new URL(url, LOCAL_BASE);
  } catch {
    return authored;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return authored;
  const restated = restatesUrl(label, parsed);
  if (!restated && !GENERIC_LINK_LABELS.has(normalizeLabel(label))) return authored;
  // Protocol-relative links point off-BB even though they look local.
  const withHost = restated || url.startsWith("//");
  const text = readablePath(parsed, withHost);
  const original = sanitize(label.trim());
  const title = original === "" ? url : `Link text "${original}" — ${url}`;
  if (text === null) return { text: null, derived: false, title, note: undefined };
  const note = original === "" ? "(from URL)" : `(from URL; link text "${original}")`;
  return { text, derived: true, title, note };
}

/** Computed on render: no timer or polling for row timestamps. */
export function referenceRecency(timestamp: number | null | undefined, now = Date.now()): { text: string; iso: string; title: string } | null {
  if (timestamp == null || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) return null;
  const date = new Date(timestamp);
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  const text = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1_440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1_440)}d ago`;
  return { text, iso: date.toISOString(), title: `Last linked ${date.toLocaleString()}` };
}

// Mentions routes contain validated queries, never arbitrary pasted prose.
import { z } from "zod";
import {
  listMentionsInputV2Schema, resolveLookupInputV2Schema, safeAuthoredHrefSchema,
  type ListMentionsInputV2, type ListMentionsOutputV2,
} from "@phosphorco/bb-cross-references";

export type MentionItem = Extract<ListMentionsOutputV2, { status: "page" }>["items"][number];
export type MentionSelection = Omit<ListMentionsInputV2, "cursor" | "ifSnapshot" | "pageSize">;
const routeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), kind: z.literal("query"), input: listMentionsInputV2Schema.refine(input => input.cursor === undefined && input.ifSnapshot === undefined && input.pageSize === undefined) }),
  z.strictObject({ v: z.literal(1), kind: z.literal("lookup"), href: safeAuthoredHrefSchema, mode: z.enum(["recognize", "exact-url"]) }),
]);
export type MentionsRoute = z.infer<typeof routeSchema>;
const ROUTE_JSON_BYTES = 131072;
const ROUTE_ENCODED_CHARS = Math.ceil(ROUTE_JSON_BYTES / 3) * 4;
const encoder = new TextEncoder();
function validatedRoute(value: unknown): MentionsRoute {
  const route = routeSchema.parse(value);
  if (route.kind === "lookup") resolveLookupInputV2Schema.parse({ version: 2, text: route.href, mode: route.mode });
  else if (encoder.encode(JSON.stringify(route.input)).length > 65536) throw new Error("Lookup input is too large.");
  return route;
}
export function mentionsSubPath(value: MentionsRoute): string {
  const bytes = encoder.encode(JSON.stringify(validatedRoute(value)));
  if (bytes.length > ROUTE_JSON_BYTES) throw new Error("Lookup is too large to share.");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `v1/${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
export function parseMentionsSubPath(subPath: string): MentionsRoute | null {
  if (subPath === "") return null;
  // Check BEFORE decoding/allocation; reject padding, extra segments and malformed UTF8.
  if (!subPath.startsWith("v1/") || subPath.length > ROUTE_ENCODED_CHARS + 3) throw new Error("Invalid or oversized lookup route.");
  const encoded = subPath.slice(3);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid lookup route.");
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  if (binary.length > ROUTE_JSON_BYTES) throw new Error("Lookup route is too large.");
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== encoded) throw new Error("Invalid lookup encoding.");
  return validatedRoute(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
export function mentionClaimKey(item: Pick<MentionItem, "source" | "target" | "producerPluginId">): string {
  return JSON.stringify([referenceIdentityKey(item.source), item.producerPluginId, referenceIdentityKey(item.target)]);
}
export function mentionItemKey(item: MentionItem, pageSlot: number): string {
  if (item.kind === "occurrence") return JSON.stringify([mentionClaimKey(item), item.kind, item.occurrenceKey]);
  // Future formats deliberately lose opaque metadata in the public decoder.
  // Preserve each admitted slot without inventing a durable identity for it.
  if (!Number.isSafeInteger(pageSlot) || pageSlot < 0 || pageSlot >= 100) throw new Error("Invalid mention page slot.");
  return JSON.stringify([mentionClaimKey(item), item.kind, "slot", pageSlot]);
}
export function mentionMessageHref(item: MentionItem): string | null {
  if (item.kind !== "occurrence" || item.source.provider !== "bb" || item.source.keys.thread !== item.locator.threadId || !item.source.keys.project) return null;
  return `/projects/${encodeURIComponent(item.source.keys.project)}/threads/${encodeURIComponent(item.locator.threadId)}#msg=${item.locator.messageSeq}`;
}
export function mentionExcerptParts(item: MentionItem): { before: string; match: string; after: string } | null {
  if (item.kind !== "occurrence" || item.excerpt.state !== "ready") return null;
  const { text, matchSpan } = item.excerpt;
  return { before: text.slice(0, matchSpan.start), match: text.slice(matchSpan.start, matchSpan.end), after: text.slice(matchSpan.end) };
}
