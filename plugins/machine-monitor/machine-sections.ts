/**
 * Shared, fleet-wide machine sections. One line per section:
 *
 *   * "All"
 *   b*-hel "Hetzner Builder"
 *   {palani,cole,florien,adam}-* "Dev Machines"
 *
 * The first whitespace-free token is a case-insensitive glob matched against
 * a machine's label or machine ID (`*`, `?`, and `{a,b}` alternation). The
 * rest of the line, optionally quoted, is the section title; without one the
 * pattern is the title. Blank lines and `#` comments are ignored.
 */

export const DEFAULT_MACHINE_SECTIONS = `* "All"`;
export const MAX_MACHINE_SECTIONS = 32;
export const MAX_MACHINE_SECTIONS_BYTES = 16 * 1024;
const MAX_PATTERN_LENGTH = 256;
const MAX_TITLE_LENGTH = 96;

export type MachineSection = Readonly<{
  slug: string;
  title: string;
  pattern: string;
  /** Lower-cased brace-free alternatives; `*` and `?` are the only wildcards. */
  alternatives: readonly string[];
}>;

export type MachineSectionsParseResult = Readonly<{
  sections: readonly MachineSection[];
  errors: readonly string[];
}>;

const MAX_ALTERNATIVES = 64;
/**
 * Matching cost grows with the total expanded pattern length (every machine
 * is tested against every alternative on each overview), so bound it across
 * the whole configuration rather than per line.
 */
export const MAX_EXPANDED_PATTERN_CHARS = 1024;

/** Expand `{a,b}` (nested allowed) into brace-free alternatives. */
function expandBraces(pattern: string, start: number, closing: boolean): { alternatives: string[]; end: number } {
  let branches: string[][] = [];
  let current: string[] = [""];
  let index = start;
  const append = (suffixes: readonly string[]) => {
    const next = current.flatMap((prefix) => suffixes.map((suffix) => prefix + suffix));
    if (next.length > MAX_ALTERNATIVES) throw new Error(`expands to more than ${MAX_ALTERNATIVES} alternatives`);
    current = next;
  };
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "{") {
      const inner = expandBraces(pattern, index + 1, true);
      append(inner.alternatives);
      index = inner.end;
      continue;
    }
    if (closing && (char === "," || char === "}")) {
      branches.push(current);
      current = [""];
      index += 1;
      if (char === "}") {
        const alternatives = branches.flat();
        if (alternatives.length > MAX_ALTERNATIVES) throw new Error(`expands to more than ${MAX_ALTERNATIVES} alternatives`);
        return { alternatives, end: index };
      }
      continue;
    }
    if (char === "}") throw new Error("has an unmatched }");
    append([char]);
    index += 1;
  }
  if (closing) throw new Error("has an unclosed {");
  branches = [current];
  return { alternatives: branches.flat(), end: index };
}

export function compileMachinePattern(pattern: string): readonly string[] {
  return [...new Set(expandBraces(pattern.toLowerCase(), 0, false).alternatives)];
}

/**
 * Iterative wildcard match: backtracks only to the most recent `*`, so it is
 * O(pattern × value) and no accepted pattern can stall rendering.
 */
function wildcardMatches(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = v;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      v = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

function slugFor(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

function parseTitle(rest: string): string | null {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return null;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  if (quoted != null) return quoted[1]!.replace(/\\(.)/g, "$1").trim() || null;
  if (/^["']/.test(trimmed)) throw new Error("has an unterminated quoted title");
  return trimmed;
}

export function parseMachineSections(text: string): MachineSectionsParseResult {
  const sections: MachineSection[] = [];
  const errors: string[] = [];
  // A slug is a route; numbering collisions would let a reorder silently
  // repoint existing links, so a colliding title is an error instead.
  const used = new Map<string, number>();
  if (new TextEncoder().encode(text).length > MAX_MACHINE_SECTIONS_BYTES) {
    return { sections, errors: [`Sections must be at most ${MAX_MACHINE_SECTIONS_BYTES / 1024} KiB.`] };
  }
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const lineNumber = index + 1;
    const [, pattern = "", rest = ""] = /^(\S+)\s*(.*)$/.exec(line) ?? [];
    try {
      if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
      const alternatives = compileMachinePattern(pattern);
      const title = parseTitle(rest) ?? pattern;
      if (title.length > MAX_TITLE_LENGTH) throw new Error(`title is longer than ${MAX_TITLE_LENGTH} characters`);
      const slug = slugFor(title);
      const earlier = used.get(slug);
      if (earlier != null) throw new Error(`title matches line ${earlier}'s; give each section a distinct title`);
      if (sections.length >= MAX_MACHINE_SECTIONS) throw new Error(`exceeds the ${MAX_MACHINE_SECTIONS}-section limit`);
      used.set(slug, lineNumber);
      sections.push({ slug, title, pattern, alternatives });
    } catch (cause) {
      errors.push(`Line ${lineNumber} ${cause instanceof Error ? cause.message : String(cause)}.`);
    }
  });
  const expanded = sections.reduce((total, section) => total + section.alternatives.reduce((sum, alternative) => sum + alternative.length, 0), 0);
  if (expanded > MAX_EXPANDED_PATTERN_CHARS) {
    errors.push(`Patterns expand to ${expanded} characters in total; simplify them to at most ${MAX_EXPANDED_PATTERN_CHARS}.`);
  }
  if (sections.length === 0 && errors.length === 0) errors.push("Add at least one section.");
  return { sections, errors };
}

/** Settings validation: accept only text that parses without errors. */
export function machineSectionsError(text: string): string | null {
  const { errors } = parseMachineSections(text);
  return errors.length === 0 ? null : errors.join(" ");
}

export function machineInSection(section: MachineSection, machine: Readonly<{ label: string; machine: Readonly<{ machineId: string }> }>): boolean {
  const label = machine.label.toLowerCase();
  const machineId = machine.machine.machineId.toLowerCase();
  return section.alternatives.some((alternative) => wildcardMatches(alternative, label) || wildcardMatches(alternative, machineId));
}

type SectionMember = Readonly<{ label: string; machine: Readonly<{ machineId: string }> }>;

/** Membership of one machine in each section, in configuration order. */
export function sectionMembership(sections: readonly MachineSection[], machine: SectionMember): boolean[] {
  return sections.map((section) => machineInSection(section, machine));
}

const machineNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * BB has no machine order of its own, so derive one from the sections.
 * A section matching fewer machines is more specific (ties keep config
 * order). Each machine is keyed by the ranks of every section it belongs to,
 * most specific first, so the narrowest section groups machines and broader
 * ones subdivide them; names then sort naturally (b2 before b10).
 */
export function orderMachinesBySections<T extends SectionMember>(
  machines: readonly T[],
  sections: readonly MachineSection[],
  membershipOf: (machine: T) => readonly boolean[] = (machine) => sectionMembership(sections, machine),
): T[] {
  const membership = machines.map(membershipOf);
  const rankOf = new Map(sections
    .map((section, index) => ({ index, size: membership.filter((row) => row[index]).length }))
    .sort((left, right) => left.size - right.size || left.index - right.index)
    .map((entry, rank) => [entry.index, rank]));
  const keyed = machines.map((machine, position) => ({
    machine,
    position,
    ranks: sections.flatMap((_, index) => membership[position]![index] ? [rankOf.get(index)!] : []).sort((left, right) => left - right),
  }));
  keyed.sort((left, right) => {
    for (let index = 0; index < Math.min(left.ranks.length, right.ranks.length); index += 1) {
      const delta = left.ranks[index]! - right.ranks[index]!;
      if (delta !== 0) return delta;
    }
    // On a shared prefix the more categorized machine comes first (and
    // machines in no section last). Deciding here, before names, keeps the
    // comparison a total order when sections overlap.
    if (left.ranks.length !== right.ranks.length) return right.ranks.length - left.ranks.length;
    return machineNameCollator.compare(left.machine.label, right.machine.label)
      || machineNameCollator.compare(left.machine.machine.machineId, right.machine.machine.machineId)
      || left.position - right.position;
  });
  return keyed.map((entry) => entry.machine);
}
