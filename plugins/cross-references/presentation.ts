const GENERIC_LINK_LABELS = new Set([
  "", "link", "here", "this", "url", "click here", "this link", "link here", "this page", "read more", "more", "source",
]);
const MAX_PATH_CHARS = 60;
// Control, format (bidi overrides, zero-width), line/paragraph separators.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export type DisplayLabel = { text: string; derived: boolean };

function normalizeLabel(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/gu, " ").toLowerCase();
}

function isGenericLabel(label: string, parsed: URL, url: string): boolean {
  const trimmed = label.trim().toLowerCase();
  if (trimmed === url.toLowerCase() || trimmed === parsed.href.toLowerCase()) return true;
  if (trimmed === parsed.host || trimmed === parsed.hostname) return true;
  return GENERIC_LINK_LABELS.has(normalizeLabel(label));
}

// Decode one segment, keeping reserved delimiters encoded so distinct URLs never look alike.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/%(2F|3F|23)/gi, "%25$1"));
  } catch {
    return segment;
  }
}

function readablePath(parsed: URL): string | null {
  const segments = parsed.pathname.split("/").map(decodeSegment);
  let path = segments.join("/").replace(UNSAFE_CHARS, "");
  if (path === "/" || path === "") return null;
  if (path.length > MAX_PATH_CHARS) {
    // Keep the end of the path: the filename or id is what tells rows apart.
    const tail = segments.filter(Boolean).slice(-2).join("/").replace(UNSAFE_CHARS, "");
    path = `…/${tail}`;
  }
  const hash = decodeSegment(parsed.hash.slice(1)).replace(UNSAFE_CHARS, "");
  return hash === "" ? path : `${path}#${hash}`;
}

// Generic link text ("link", "here") says nothing; show the URL path the anchor hid instead.
// Query strings are left out: they are mostly tracking or token noise.
export function displayLabel(label: string, url: string | undefined): DisplayLabel {
  const authored = { text: label, derived: false };
  if (url == null) return authored;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://bb.invalid");
  } catch {
    return authored;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return authored;
  if (!isGenericLabel(label, parsed, url)) return authored;
  const path = readablePath(parsed);
  return path === null ? authored : { text: path, derived: true };
}
