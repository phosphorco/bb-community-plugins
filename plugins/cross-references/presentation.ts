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
