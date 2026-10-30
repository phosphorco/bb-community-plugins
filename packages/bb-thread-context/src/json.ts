// Descriptor-safe bounded JSON admission, shared implementation with bb-thread-membership.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Nesting depth of a snapshot (root scalar = 0), computed without recursion. */
function depth(value: JsonValue): number {
  let max = 0;
  const stack: [JsonValue, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [current, level] = stack.pop()!;
    if (current === null || typeof current !== 'object') continue;
    const children = Array.isArray(current) ? current : Object.values(current);
    if (children.length > 0) max = Math.max(max, level + 1);
    for (const child of children) stack.push([child, level + 1]);
  }
  return max;
}

/**
 * A detached plain-JSON snapshot, read only through own data descriptors.
 * Accepts null, booleans, strings, finite numbers, dense arrays (every index an
 * own enumerable data property, no other own keys besides `length`) and
 * ordinary objects (Object or null prototype, string keys only, each an own
 * enumerable data property). Never invokes getters, `toJSON`, or other hooks;
 * cycles and anything else throw `TypeError` (a child shared by two parents is
 * copied twice). The result shares nothing with the input.
 *
 * Iterative: no depth limit and no recursion. `maxNodes` (default unbounded)
 * caps the values visited; exceeding it throws `RangeError`. The value is
 * already in memory, and each container's own keys are enumerated before its
 * children are counted, so the bound limits the walk, not prior allocation.
 */
export function plainJsonSnapshot(value: unknown, options: { readonly maxNodes?: number } = {}): JsonValue {
  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
  let nodes = 0;
  let result: JsonValue = null;
  type Work = { source: unknown; assign: (snapshot: JsonValue) => void } | { exit: object };
  const work: Work[] = [{ source: value, assign: (snapshot) => { result = snapshot; } }];
  /** Containers on the current path; a shared child reached twice is fine, an ancestor is a cycle. */
  const ancestors = new Set<object>();
  const reserve = (count: number) => {
    nodes += count;
    if (nodes > maxNodes) throw new RangeError('JSON exceeds its node budget.');
  };
  reserve(1);
  while (work.length > 0) {
    const item = work.pop()!;
    if ('exit' in item) { ancestors.delete(item.exit); continue; }
    const { source, assign } = item;
    if (source === null || typeof source === 'boolean' || typeof source === 'string') { assign(source); continue; }
    if (typeof source === 'number') {
      if (!Number.isFinite(source)) throw new TypeError('Non-finite number.');
      assign(source);
      continue;
    }
    if (typeof source !== 'object') throw new TypeError('Not plain JSON.');
    if (ancestors.has(source)) throw new TypeError('Cyclic structures are not JSON.');
    ancestors.add(source);
    // Pushed before the children, so it is popped after all of them.
    work.push({ exit: source });
    const keys = Reflect.ownKeys(source);
    if (Array.isArray(source)) {
      if (Object.getPrototypeOf(source) !== Array.prototype) throw new TypeError('Not a plain array.');
      const length = (Object.getOwnPropertyDescriptor(source, 'length') as PropertyDescriptor).value as number;
      if (keys.length !== length + 1) throw new TypeError('Arrays must be dense with no extra properties.');
      reserve(length);
      const out: JsonValue[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Arrays must be dense data properties.');
        out.push(null);
        work.push({ source: descriptor.value, assign: (snapshot) => { out[i] = snapshot; } });
      }
      assign(out);
      continue;
    }
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Not a plain object.');
    reserve(keys.length);
    const out: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('Symbol keys are not JSON.');
      const descriptor = Object.getOwnPropertyDescriptor(source, key) as PropertyDescriptor;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Objects must hold enumerable data properties only.');
      // defineProperty keeps a "__proto__" key an ordinary own key.
      const define = (snapshot: JsonValue) => Object.defineProperty(out, key, { value: snapshot, writable: true, enumerable: true, configurable: true });
      define(null);
      work.push({ source: descriptor.value, assign: define });
    }
    assign(out);
  }
  return result;
}

/** Canonical JSON of a plain-JSON snapshot: sorted keys. Throws `TypeError` for anything else. Iterative; no depth limit. */
export function canonicalJson(value: unknown): string {
  return canonicalText(plainJsonSnapshot(value), Number.POSITIVE_INFINITY)!;
}

/**
 * `canonicalJson` within a UTF-8 byte budget: `null` once the text would exceed
 * `maxBytes`. Visits at most `maxBytes` values (every JSON value serializes to
 * at least one byte). Throws `TypeError` for non-JSON input.
 */
export function canonicalJsonWithin(value: unknown, maxBytes: number): string | null {
  let snapshot: JsonValue;
  try { snapshot = plainJsonSnapshot(value, { maxNodes: maxBytes }); } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return canonicalText(snapshot, maxBytes);
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** Iterative canonical serialization; `null` as soon as the byte budget is exceeded. */
function canonicalText(value: JsonValue, maxBytes: number): string | null {
  const parts: string[] = [];
  let bytes = 0;
  const work: ({ text: string } | { value: JsonValue })[] = [{ value }];
  while (work.length > 0) {
    const item = work.pop()!;
    let text: string;
    if ('text' in item) text = item.text;
    else if (item.value === null || typeof item.value !== 'object') text = JSON.stringify(item.value);
    else if (Array.isArray(item.value)) {
      const array = item.value;
      work.push({ text: ']' });
      for (let i = array.length - 1; i >= 0; i--) {
        work.push({ value: array[i]! });
        if (i > 0) work.push({ text: ',' });
      }
      text = '[';
    } else {
      const record = item.value as { [key: string]: JsonValue };
      const keys = Object.keys(record).sort();
      work.push({ text: '}' });
      for (let i = keys.length - 1; i >= 0; i--) {
        work.push({ value: record[keys[i]!]! });
        work.push({ text: `${JSON.stringify(keys[i])}:` });
        if (i > 0) work.push({ text: ',' });
      }
      text = '{';
    }
    bytes += utf8Length(text);
    if (bytes > maxBytes) return null;
    parts.push(text);
  }
  return parts.join('');
}

/**
 * Opaque supplier scope: plain JSON, ≤ scopeBytes canonical, ≤ scopeDepth.
 * The parsed value is a detached snapshot, so what was validated is exactly
 * what is sent, whatever later happens to the caller's object.
 */
