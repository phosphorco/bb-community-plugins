/** Ordered #tags stored in a thread title. No storage, SDK, UI or locale state. */
export function normalizeTag(value: string): string | null {
  const tag = value.trim().replace(/^#/u, '').normalize('NFC').toLowerCase().normalize('NFC');
  if (!tag || tag.length > 64 || !/^[\p{L}\p{N}\p{M}_-]+$/u.test(tag) || /^\p{N}+$/u.test(tag)) return null;
  return tag;
}

export function normalizeTags(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeTag).filter((tag): tag is string => tag !== null))];
}

interface TagSpan { start: number; end: number; tag: string }
function tagSpans(title: string): TagSpan[] {
  const spans: TagSpan[] = [];
  // Validate the entire whitespace-delimited token: never eat a valid prefix of #c++ or #foo.bar.
  for (const match of title.matchAll(/(^|\s)#(\S+)/gu)) {
    const tag = normalizeTag(match[2]!);
    if (tag === null || match[2]!.startsWith('#')) continue;
    const start = match.index! + match[1]!.length;
    spans.push({ start, end: start + match[2]!.length + 1, tag });
  }
  return spans;
}

export function readTags(title: string): string[] {
  return [...new Set(tagSpans(title).map(span => span.tag))];
}
export function hasTag(title: string, value: string): boolean {
  const tag = normalizeTag(value);
  return tag !== null && readTags(title).includes(tag);
}

function removeSpans(title: string, spans: readonly TagSpan[]): string {
  const ranges: { start: number; end: number }[] = [];
  for (const span of spans) {
    let { start, end } = span;
    // Remove only separators adjacent to the deleted token, preserving all unrelated text.
    while (end < title.length && /\s/u.test(title[end]!)) end++;
    if (end === title.length) while (start > 0 && /\s/u.test(title[start - 1]!)) start--;
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const tail = ranges.at(-1);
  if (tail?.end === title.length) while (tail.start > 0 && /\s/u.test(title[tail.start - 1]!)) tail.start--;
  let result = '', offset = 0;
  for (const range of ranges) { result += title.slice(offset, range.start); offset = range.end; }
  return result + title.slice(offset);
}

export function removeTag(title: string, value: string): string {
  const tag = normalizeTag(value);
  return tag === null ? title : removeSpans(title, tagSpans(title).filter(span => span.tag === tag));
}
export function addTag(title: string, value: string): string {
  const tag = normalizeTag(value);
  if (tag === null || hasTag(title, tag)) return title;
  return `${title}${title && !/\s$/u.test(title) ? ' ' : ''}#${tag}`;
}
export function toggleTag(title: string, value: string, force?: boolean): string {
  return (force ?? !hasTag(title, value)) ? addTag(title, value) : removeTag(title, value);
}

/** Ordered replacement for a picker draft; retains the longest surviving prefix in place. */
export function setTags(title: string, values: readonly string[]): string {
  const wanted = normalizeTags(values), current = readTags(title);
  if (wanted.length === current.length && wanted.every((tag, i) => tag === current[i])) return title;
  let prefix = 0;
  for (const tag of current) if (tag === wanted[prefix]) prefix++;
  const retained = new Set(wanted.slice(0, prefix));
  let result = removeSpans(title, tagSpans(title).filter(span => !retained.has(span.tag)));
  for (const tag of wanted.slice(prefix)) result = addTag(result, tag);
  return result;
}

/** Removes recognized tokens only; consumers may separately normalize whitespace for display. */
export function stripTags(title: string): string { return removeSpans(title, tagSpans(title)); }
