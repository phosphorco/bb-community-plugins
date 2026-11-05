import {
  InputSchemas, PathSchema, IdentifierSchema, canonicalJson, decodeInput, sourceRefEqual,
} from '@phosphorco/bb-turn-results';
import type { ResultIdentity, ResultProof, SourceRef, FileIdentity, RouteProvenance } from '@phosphorco/bb-turn-results';
import { adaptCompletedEvent } from '@phosphorco/bb-turn-results/events';
import type { NativeHistoryEvent } from '@phosphorco/bb-turn-results/events';
import { imageCandidate, imageIdentity, IMAGE_KIND, IMAGE_PROVIDER } from './recognition.ts';
import { MAX_MATERIALIZATION_BYTES } from './image-policy.ts';
export { MAX_MATERIALIZATION_BYTES } from './image-policy.ts';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
export const MAX_IMAGE_DIMENSION = 32_768;
export const MAX_IMAGE_PIXELS = 16_777_216;
type HostTarget = Extract<FileIdentity, { kind: 'host' }>;
type NativeImageProof = Extract<ResultProof, { kind: 'native-image' }>;
export interface ImageMaterialization {
  schema: 1; identity: ResultIdentity; proof: NativeImageProof; providerSha256: string;
  path: string; target: HostTarget; nativeCreatedAt: number; width: number; height: number;
  sizeBytes: number; verifiedAt: number;
}
export interface ImageFileRead {
  path: string; content: string; contentEncoding: 'base64' | 'utf8'; sha256: string;
  sizeBytes: number; mimeType?: string; observedAt: number;
}
/** Bounds are requests to source-owned wrappers AFTER SDK parsing. They are
 * not native transport/pre-parse allocation guarantees. Registration supplies
 * the one 1300ms total deadline by aborting signal; no per-port retry/timer here.
 */
export interface ImageVerificationPorts {
  materializations: { read(source: SourceRef, options: { signal: AbortSignal; maxBytes: number }): Promise<ImageMaterialization | null> };
  native: { read(source: SourceRef, options: { signal: AbortSignal; limit: 1; maxResultChars: number }): Promise<NativeHistoryEvent | null> };
  currentHost: { lookup(threadId: string, options: { signal: AbortSignal }): Promise<{ hostId: string; observedAt: number } | null> };
  files: { read(options: { hostId: string; path: string; signal: AbortSignal; maxBytes: number }): Promise<ImageFileRead> };
}
export class ImagePortError extends Error {
  constructor(readonly reason: 'missing' | 'offline' | 'unsupported' | 'unavailable') { super(reason); this.name = 'ImagePortError'; }
}
export interface ImageHistory {
  identity: ResultIdentity; proof: NativeImageProof; nativeCreatedAt: number; path: string;
  providerSha256: string | null;
}
export type ImageVerification =
  | { state: 'unrecognized' | 'conflict'; reason: string }
  | { state: 'unavailable'; reason: string; historical: ImageHistory | null }
  | { state: 'verified'; binding: ImageMaterialization; basis: 'native' | 'materialization';
      route: { kind: 'file'; target: HostTarget }; provenance: RouteProvenance;
      observedAt: number; layout: { width: number; height: number } | null;
      displayUnsupported: 'dimensions-over-policy' | null };
class VerificationFault extends Error { constructor(readonly reason: string) { super(reason); } }
const fault = (reason: string): never => { throw new VerificationFault(reason); };
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const absolutePath = (path: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) && !path.split(/[\\/]/u).includes('..');
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : undefined;
}
/** Race every await, including crypto, against caller cancellation. An ignored
 * signal can leave already-dispatched work running but cannot start a next read.
 */
async function step<T>(signal: AbortSignal, work: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(value => {
        if (signal.aborted) reject(signal.reason); else resolve(value);
      }, error => reject(signal.aborted ? signal.reason : error));
    });
  } finally { signal.removeEventListener('abort', abort); }
}
function sextet(char: number): number {
  return char >= 65 && char <= 90 ? char - 65 : char >= 97 && char <= 122 ? char - 71
    : char >= 48 && char <= 57 ? char + 4 : char === 43 ? 62 : char === 47 ? 63 : -1;
}
/** Complete canonical base64 only: no whitespace, data URI, URL alphabet,
 * missing padding, nonzero pad bits or truncated retained fragments.
 */
function imageBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value.length) return fault('provider-evidence-missing');
  if (value.length > MAX_IMAGE_BASE64_CHARS) return fault('image-over-byte-cap');
  if (value.length % 4) return fault('invalid-base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const size = value.length / 4 * 3 - padding;
  if (size > MAX_IMAGE_BYTES) return fault('image-over-byte-cap');
  for (let index = 0; index < value.length - padding; index++) if (sextet(value.charCodeAt(index)) < 0) return fault('invalid-base64');
  if (padding === 2 && (sextet(value.charCodeAt(value.length - 3)) & 15)
    || padding === 1 && (sextet(value.charCodeAt(value.length - 2)) & 3)) return fault('invalid-base64');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = sextet(value.charCodeAt(index)), b = sextet(value.charCodeAt(index + 1));
    const c = index + 2 < value.length - padding ? sextet(value.charCodeAt(index + 2)) : 0;
    const d = index + 3 < value.length - padding ? sextet(value.charCodeAt(index + 3)) : 0;
    if (offset < size) bytes[offset++] = a << 2 | b >> 4;
    if (offset < size) bytes[offset++] = b << 4 | c >> 2;
    if (offset < size) bytes[offset++] = c << 6 | d;
  }
  return bytes;
}
async function digest(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const hash = await step(signal, () => crypto.subtle.digest('SHA-256', bytes));
  signal.throwIfAborted();
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function dimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, index) => value !== bytes[index])) return fault('unsupported-media');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return fault('invalid-png-header');
  const width = view.getUint32(16), height = view.getUint32(20);
  const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[bytes[25]!]?.includes(bytes[24]!)
    || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) return fault('invalid-png-header');
  let crc = 0xffffffff;
  for (let index = 12; index < 29; index++) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(29)) return fault('invalid-png-header');
  return { width, height };
}
function readMaterialization(raw: ImageMaterialization, requested: ResultIdentity): ImageMaterialization {
  canonicalJson(raw, MAX_MATERIALIZATION_BYTES);
  const keys = ['schema', 'identity', 'proof', 'providerSha256', 'path', 'target', 'nativeCreatedAt', 'width', 'height', 'sizeBytes', 'verifiedAt'];
  if (Object.keys(raw).sort().join(',') !== keys.sort().join(',') || raw.schema !== 1) return fault('invalid-materialization');
  const identity = decodeInput(InputSchemas.identity, raw.identity);
  const proof = InputSchemas.proof.parse(raw.proof), target = InputSchemas.file.parse(raw.target);
  const path = PathSchema.parse(raw.path);
  if (!same(identity, requested)) return fault('materialization-identity-conflict');
  if (!absolutePath(path) || !same(imageIdentity(identity.ref.source, identity.evidence.selectedDigest, path), identity)
    || proof.kind !== 'native-image' || !sourceRefEqual(proof.source, identity.ref.source)
    || proof.selectedDigest !== identity.evidence.selectedDigest || !sha(raw.providerSha256)
    || proof.artifactDigest !== raw.providerSha256 || target.kind !== 'host' || !absolutePath(target.path) || target.path !== path
    || !integer(raw.nativeCreatedAt) || !integer(raw.verifiedAt) || !integer(raw.sizeBytes) || !raw.sizeBytes || raw.sizeBytes > MAX_IMAGE_BYTES
    || !integer(raw.width) || !integer(raw.height) || !raw.width || !raw.height || raw.width > 0x7fffffff || raw.height > 0x7fffffff) return fault('invalid-materialization');
  return { schema: 1, identity, proof, providerSha256: raw.providerSha256, path, target,
    nativeCreatedAt: raw.nativeCreatedAt, verifiedAt: raw.verifiedAt, width: raw.width, height: raw.height, sizeBytes: raw.sizeBytes };
}
function history(binding: ImageMaterialization): ImageHistory {
  return { identity: binding.identity, proof: binding.proof, path: binding.path,
    nativeCreatedAt: binding.nativeCreatedAt, providerSha256: binding.providerSha256 };
}

/** Returns sparse source-owned commit proposals only. No bytes, transcript,
 * preview lease, storage writes, current-host substitution or source retries.
 */
export async function verifyImage(identity: ResultIdentity, ports: ImageVerificationPorts,
  signal: AbortSignal): Promise<ImageVerification> {
  signal.throwIfAborted();
  let requested: ResultIdentity;
  try {
    requested = decodeInput(InputSchemas.identity, identity);
    if (requested.ref.kind !== IMAGE_KIND || requested.artifact.provider !== IMAGE_PROVIDER) return { state: 'unrecognized', reason: 'not-native-image-identity' };
  } catch { return { state: 'unrecognized', reason: 'invalid-identity' }; }
  let binding: ImageMaterialization | null = null, historical: ImageHistory | null = null;
  let basis: 'native' | 'materialization' = 'native';
  try {
    const cached = await step(signal, () => ports.materializations.read(requested.ref.source,
      { signal, maxBytes: MAX_MATERIALIZATION_BYTES }));
    signal.throwIfAborted();
    if (cached !== null) {
      try { binding = readMaterialization(cached, requested); }
      catch (error) { signal.throwIfAborted(); return { state: 'conflict', reason: error instanceof VerificationFault ? error.reason : 'invalid-materialization' }; }
      historical = history(binding); basis = 'materialization';
    } else {
      const native = await step(signal, () => ports.native.read(requested.ref.source,
        { signal, limit: 1, maxResultChars: MAX_IMAGE_BASE64_CHARS }));
      signal.throwIfAborted();
      if (native === null) return { state: 'unavailable', reason: 'native-source-missing', historical: null };
      const selected = await step(signal, () => adaptCompletedEvent(native));
      signal.throwIfAborted();
      if (selected.state !== 'admitted') return { state: 'unrecognized', reason: 'native-source-not-admitted' };
      const candidate = imageCandidate(selected.event);
      if (!candidate || !same(candidate.identity, requested)) return { state: 'unrecognized', reason: 'native-identity-mismatch' };
      const path = selected.event.item.type === 'imageGeneration' ? selected.event.item.path! : '';
      const proof: NativeImageProof = { kind: 'native-image', source: requested.ref.source, selectedDigest: requested.evidence.selectedDigest };
      historical = { identity: requested, proof, path, nativeCreatedAt: selected.event.createdAt, providerSha256: null };
      if (!absolutePath(path)) return { state: 'unavailable', reason: 'unsupported-path', historical };
      if (selected.event.text.result?.nativeTruncation !== null) return { state: 'unavailable', reason: 'provider-evidence-truncated', historical };
      signal.throwIfAborted();
      const item = own(own(native, 'data'), 'item');
      // First access to provider result occurs ONLY after selected identity,
      // completed status/error/path and upstream retention metadata validated.
      const providerBytes = imageBytes(own(item, 'result'));
      signal.throwIfAborted();
      const providerSha256 = await digest(providerBytes, signal);
      signal.throwIfAborted();
      historical = { ...historical, providerSha256, proof: { ...proof, artifactDigest: providerSha256 } };
      const size = dimensions(providerBytes);
      signal.throwIfAborted();
      const host = await step(signal, () => ports.currentHost.lookup(requested.ref.source.threadId, { signal }));
      signal.throwIfAborted();
      if (!host) return { state: 'unavailable', reason: 'current-host-unknown', historical };
      if (!IdentifierSchema.safeParse(host.hostId).success || !integer(host.observedAt)) return { state: 'unavailable', reason: 'invalid-current-host', historical };
      binding = { schema: 1, identity: requested, proof: historical.proof, providerSha256, path,
        target: { kind: 'host', hostId: host.hostId, path }, nativeCreatedAt: selected.event.createdAt,
        width: size.width, height: size.height, sizeBytes: providerBytes.length, verifiedAt: 0 };
    }
    signal.throwIfAborted();
    const target = binding.target;
    const file = await step(signal, () => ports.files.read({ hostId: target.hostId, path: target.path, signal, maxBytes: MAX_IMAGE_BYTES }));
    signal.throwIfAborted();
    // Capture metadata/bytes once before crypto awaits; never return content.
    const { path, sha256, sizeBytes, mimeType, observedAt, contentEncoding, content } = file;
    if (path !== target.path || !integer(sizeBytes) || sizeBytes > MAX_IMAGE_BYTES || sizeBytes !== binding.sizeBytes
      || !sha(sha256) || !integer(observedAt)) return { state: 'unavailable', reason: 'file-metadata-mismatch', historical };
    if (mimeType !== 'image/png') return { state: 'unavailable', reason: 'unsupported-file-media', historical };
    if (contentEncoding !== 'base64') return { state: 'unavailable', reason: 'unsupported-file-encoding', historical };
    const fileBytes = imageBytes(content);
    signal.throwIfAborted();
    if (fileBytes.length !== sizeBytes) return { state: 'unavailable', reason: 'file-size-mismatch', historical };
    const actualSha = await digest(fileBytes, signal);
    signal.throwIfAborted();
    if (actualSha !== sha256 || actualSha !== binding.providerSha256) return { state: 'unavailable', reason: 'file-digest-mismatch', historical };
    const size = dimensions(fileBytes);
    if (size.width !== binding.width || size.height !== binding.height) return { state: 'conflict', reason: 'materialization-dimensions-mismatch' };
    if (basis === 'native') binding = { ...binding, verifiedAt: observedAt };
    try { canonicalJson(binding, MAX_MATERIALIZATION_BYTES); }
    catch { return { state: 'unavailable', reason: 'materialization-byte-cap', historical }; }
    const displayUnsupported = size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION
      || size.width * size.height > MAX_IMAGE_PIXELS ? 'dimensions-over-policy' : null;
    signal.throwIfAborted();
    return { state: 'verified', binding, basis, route: { kind: 'file', target }, observedAt,
      provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation:
        { state: 'verified', target, observedAt, basis: 'explicit-host-read', sha256: actualSha } },
      layout: displayUnsupported ? null : size, displayUnsupported };
  } catch (error) {
    signal.throwIfAborted();
    return { state: 'unavailable', reason: error instanceof VerificationFault ? error.reason
      : error instanceof ImagePortError ? error.reason : 'source-error', historical };
  }
}
