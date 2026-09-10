import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_RESOURCE_KEYS = 32;
export const MAX_KEY_VALUE_BYTES = 512;
export const MAX_KEY_VALUE_MATERIAL_BYTES = 8_192;
export const MAX_CANONICAL_IDENTITY_BYTES = 16 * 1024;
export const MAX_PRESENTATION_BYTES = 4 * 1024;
export const MAX_PRESENTATION_LABEL_BYTES = 256;
export const MAX_PRESENTATION_DETAIL_BYTES = 1_024;
export const MAX_PRESENTATION_URL_BYTES = 2_048;
export const MAX_TARGETS = 256;
export const MAX_PROJECTION_PAYLOAD_BYTES = 256 * 1024;
export const MAX_MUTATION_ID_BYTES = 128;
export const MACHINE_MONITOR_ROUTE = "/plugins/machine-monitor/machine-monitor";

const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_PATTERN = /\p{Cc}/u;
const encoder = new TextEncoder();

export type Presentation = {
  label: string;
  detail?: string;
  url?: string;
};

export type ResourceIdentity = {
  provider: string;
  keys: Record<string, string>;
};

export type Resource = ResourceIdentity & {
  presentation: Presentation;
};

export interface CanonicalIdentity extends ResourceIdentity {
  canonicalKeysJson: string;
  canonicalIdentityJson: string;
  identityDigest: string;
}

export interface CanonicalResource extends Resource, CanonicalIdentity {
  presentationJson: string;
}

export class CrossReferenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossReferenceValidationError";
  }
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function fail(message: string): never {
  throw new CrossReferenceValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be a plain object.`);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    fail(`${label} must not contain symbol keys.`);
  }
}

function assertExactObjectKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${label} contains unknown field ${key}.`);
  }
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(`${label} contains malformed Unicode.`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(`${label} contains malformed Unicode.`);
    }
  }
}

function assertSafeText(value: string, label: string, maxBytes: number, options: { nonblank?: boolean } = {}): string {
  assertWellFormedUnicode(value, label);
  if (CONTROL_PATTERN.test(value)) fail(`${label} contains a Unicode control character.`);
  if (options.nonblank === true && value.trim().length === 0) fail(`${label} must not be blank.`);
  if (utf8ByteLength(value) > maxBytes) fail(`${label} exceeds its ${maxBytes}-byte limit.`);
  return value;
}

function assertName(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    fail(`${label} must match ^[a-z][a-z0-9._-]{0,63}$.`);
  }
  return value;
}

export function validateBbId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail(`${label} must match ^[A-Za-z0-9_-]{1,128}$.`);
  }
  return value;
}

function validateBbIdentity(provider: string, keys: Record<string, string>): void {
  if (provider !== "bb") return;
  const names = Object.keys(keys);
  if (names.length === 1 && names[0] === "project") {
    validateBbId(keys.project, "projectId");
    return;
  }
  if (names.length === 2 && names[0] === "project" && names[1] === "thread") {
    validateBbId(keys.project, "projectId");
    validateBbId(keys.thread, "threadId");
    return;
  }
  if (names.length === 2 && names[0] === "page" && names[1] === "plugin"
    && keys.page === "machine-monitor" && keys.plugin === "machine-monitor") {
    return;
  }
  fail("provider bb must use a v1 project, thread, or Machine Monitor identity.");
}

export function validateProducerPluginId(value: unknown): string {
  return assertName(value, "producerPluginId");
}

export function validateMutationId(value: unknown): string {
  if (typeof value !== "string" || utf8ByteLength(value) > MAX_MUTATION_ID_BYTES || !UUID_PATTERN.test(value)) {
    fail("mutationId must be a lower-case UUID string.");
  }
  return value;
}

export function validateRevision(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${label} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

export function validateDigest(value: unknown, label = "payloadDigest"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be lower-case SHA-256 hex.`);
  }
  return value;
}

function canonicalizeKeyMap(value: unknown): { keys: Record<string, string>; canonicalKeysJson: string } {
  assertPlainObject(value, "keys");
  const keyNames = Object.keys(value);
  if (keyNames.length < 1 || keyNames.length > MAX_RESOURCE_KEYS) {
    fail(`keys must contain between 1 and ${MAX_RESOURCE_KEYS} entries.`);
  }

  let materialBytes = 0;
  const entries = keyNames.map((key) => {
    assertName(key, "key name");
    const rawValue = value[key];
    if (typeof rawValue !== "string") fail(`key ${key} value must be a string.`);
    const normalizedValue = rawValue.normalize("NFC");
    const safeValue = assertSafeText(normalizedValue, `key ${key} value`, MAX_KEY_VALUE_BYTES, { nonblank: true });
    materialBytes += utf8ByteLength(key) + utf8ByteLength(safeValue);
    return [key, safeValue] as const;
  });
  if (materialBytes > MAX_KEY_VALUE_MATERIAL_BYTES) {
    fail(`combined key/value material exceeds its ${MAX_KEY_VALUE_MATERIAL_BYTES}-byte limit.`);
  }

  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const keys = Object.fromEntries(entries) as Record<string, string>;
  return { keys, canonicalKeysJson: JSON.stringify(keys) };
}

export function canonicalizeIdentity(value: ResourceIdentity): CanonicalIdentity {
  assertPlainObject(value, "resource identity");
  assertExactObjectKeys(value, ["provider", "keys"], "resource identity");
  const provider = assertName(value.provider, "provider");
  const { keys, canonicalKeysJson } = canonicalizeKeyMap(value.keys);
  validateBbIdentity(provider, keys);
  const identityObject = { provider, keys };
  const canonicalIdentityJson = JSON.stringify(identityObject);
  if (utf8ByteLength(canonicalIdentityJson) > MAX_CANONICAL_IDENTITY_BYTES) {
    fail(`canonical identity exceeds its ${MAX_CANONICAL_IDENTITY_BYTES}-byte limit.`);
  }
  return {
    provider,
    keys,
    canonicalKeysJson,
    canonicalIdentityJson,
    identityDigest: sha256Hex(canonicalIdentityJson),
  };
}

function canonicalizePresentation(value: unknown): { presentation: Presentation; presentationJson: string } {
  assertPlainObject(value, "presentation");
  assertExactObjectKeys(value, ["label", "detail", "url"], "presentation");
  if (typeof value.label !== "string") fail("presentation.label must be a string.");
  const label = assertSafeText(value.label, "presentation.label", MAX_PRESENTATION_LABEL_BYTES, { nonblank: true });
  const presentation: Presentation = { label };

  if (value.detail !== undefined) {
    if (typeof value.detail !== "string") fail("presentation.detail must be a string when supplied.");
    presentation.detail = assertSafeText(value.detail, "presentation.detail", MAX_PRESENTATION_DETAIL_BYTES, { nonblank: true });
  }
  if (value.url !== undefined) {
    if (typeof value.url !== "string") fail("presentation.url must be a string when supplied.");
    const url = assertSafeText(value.url, "presentation.url", MAX_PRESENTATION_URL_BYTES, { nonblank: true });
    if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) {
      presentation.url = url;
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("presentation.url must use http or https.");
        presentation.url = url;
      } catch {
        fail("presentation.url must be a valid http or https URL.");
      }
    } else {
      fail("presentation.url must be a same-origin route or an http(s) URL.");
    }
  }

  const presentationJson = JSON.stringify(presentation);
  if (utf8ByteLength(presentationJson) > MAX_PRESENTATION_BYTES) {
    fail(`presentation exceeds its ${MAX_PRESENTATION_BYTES}-byte limit.`);
  }
  return { presentation, presentationJson };
}

export function canonicalizeResource(value: Resource): CanonicalResource {
  assertPlainObject(value, "resource");
  assertExactObjectKeys(value, ["provider", "keys", "presentation"], "resource");
  const identity = canonicalizeIdentity({ provider: value.provider, keys: value.keys });
  const presentation = canonicalizePresentation(value.presentation);
  return { ...identity, ...presentation };
}

export function resourceIdentityOf(resource: CanonicalResource): ResourceIdentity {
  return { provider: resource.provider, keys: resource.keys };
}

/** The installation-local BB identity conventions used by the first slice. */
export function projectIdentity(projectId: string): ResourceIdentity {
  return { provider: "bb", keys: { project: validateBbId(projectId, "projectId") } };
}

export function threadIdentity(projectId: string, threadId: string): ResourceIdentity {
  return {
    provider: "bb",
    keys: {
      project: validateBbId(projectId, "projectId"),
      thread: validateBbId(threadId, "threadId"),
    },
  };
}

export function machineMonitorIdentity(): ResourceIdentity {
  return { provider: "bb", keys: { page: "machine-monitor", plugin: "machine-monitor" } };
}

export function projectResource(projectId: string, presentation: Presentation): Resource {
  return { ...projectIdentity(projectId), presentation };
}

export function threadResource(projectId: string, threadId: string, presentation: Presentation): Resource {
  return { ...threadIdentity(projectId, threadId), presentation };
}

export function machineMonitorResource(presentation: Presentation = {
  label: "Machine Monitor",
  url: MACHINE_MONITOR_ROUTE,
}): Resource {
  return { ...machineMonitorIdentity(), presentation };
}

export function serializeResource(resource: CanonicalResource): Resource {
  return {
    provider: resource.provider,
    keys: resource.keys,
    presentation: resource.presentation,
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function projectionPayloadJson(
  producerPluginId: string,
  source: CanonicalResource,
  tombstone: boolean,
  targets: readonly CanonicalResource[],
): string {
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    producerPluginId,
    source: serializeResource(source),
    tombstone,
    targets: targets.map(serializeResource),
  };
  const json = JSON.stringify(payload);
  if (utf8ByteLength(json) > MAX_PROJECTION_PAYLOAD_BYTES) {
    fail(`projection payload exceeds its ${MAX_PROJECTION_PAYLOAD_BYTES}-byte limit.`);
  }
  return json;
}

export function projectionPayloadDigest(
  producerPluginId: string,
  source: CanonicalResource,
  tombstone: boolean,
  targets: readonly CanonicalResource[],
): string {
  return sha256Hex(projectionPayloadJson(producerPluginId, source, tombstone, targets));
}
