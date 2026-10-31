import { canonicalJson, InputSchemas } from '@phosphorco/bb-turn-results';
import type { ResultIdentity } from '@phosphorco/bb-turn-results';
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from './verification.ts';

/** Private source protocol. Consumers deliberately own a structural codec;
 * this module is not a cross-plugin import or another presentation registry.
 */
export const IMAGE_MEDIA_METHOD = 'turnResultImagesV1Media';
export const IMAGE_MEDIA_INPUT_BYTES = 8_192;
export const IMAGE_MEDIA_OUTPUT_BYTES = 16_384;
export const IMAGE_MEDIA_DEADLINE_MS = 1_300;
export const IMAGE_MEDIA_TTL_MS = 120_000;
export interface ImageMediaInput { version: 1; identity: ResultIdentity }
export interface ImageMediaLease {
  targetFingerprint: string; leaseGeneration: string; baseUrl: string; url: string;
  expiresAtMs: number; resolvedAt: number;
}
export type ImageMediaOutput =
  | { version: 1; state: 'ready'; lease: ImageMediaLease;
      image: { mimeType: 'image/png'; width: number; height: number; sizeBytes: number; sha256: string } }
  | { version: 1; state: 'unavailable'; reason: string };

function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== keys.length || !keys.every(key => Object.hasOwn(raw, key))) throw new Error('Unexpected media fields.');
  return raw as Record<string, unknown>;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function sha(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value); }

export function decodeImageMediaInput(raw: unknown): ImageMediaInput {
  canonicalJson(raw, IMAGE_MEDIA_INPUT_BYTES);
  const value = object(raw, ['version', 'identity']);
  if (value.version !== 1) throw new Error('Unsupported media version.');
  return { version: 1, identity: InputSchemas.identity.parse(value.identity) };
}
/** Exact server-produced fields, charged before decoding. The gallery uses its
 * own additive decoder and separately correlates fingerprint with route/hash.
 */
export function decodeImageMediaOutput(raw: unknown): ImageMediaOutput {
  canonicalJson(raw, IMAGE_MEDIA_OUTPUT_BYTES);
  if (!raw || typeof raw !== 'object') throw new Error('Invalid media output.');
  if ('state' in raw && raw.state === 'unavailable') {
    const value = object(raw, ['version', 'state', 'reason']);
    if (value.version !== 1 || typeof value.reason !== 'string' || !/^[a-z0-9-]{1,128}$/u.test(value.reason)) throw new Error('Invalid media failure.');
    return { version: 1, state: 'unavailable', reason: value.reason };
  }
  const value = object(raw, ['version', 'state', 'lease', 'image']);
  if (value.version !== 1 || value.state !== 'ready') throw new Error('Invalid media state.');
  const lease = object(value.lease, ['targetFingerprint', 'leaseGeneration', 'baseUrl', 'url', 'expiresAtMs', 'resolvedAt']);
  const image = object(value.image, ['mimeType', 'width', 'height', 'sizeBytes', 'sha256']);
  if (!sha(lease.targetFingerprint) || typeof lease.leaseGeneration !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(lease.leaseGeneration)
    || typeof lease.baseUrl !== 'string' || !/^\/api\/v1\/file-previews\/[A-Za-z0-9-]{1,128}$/u.test(lease.baseUrl)
    || typeof lease.url !== 'string' || !lease.url.startsWith(`${lease.baseUrl}/`)
    || !integer(lease.resolvedAt) || !integer(lease.expiresAtMs) || lease.expiresAtMs <= lease.resolvedAt
    || lease.expiresAtMs - lease.resolvedAt > IMAGE_MEDIA_TTL_MS) throw new Error('Invalid media lease.');
  const basename = lease.url.slice(lease.baseUrl.length + 1);
  let decoded: string;
  try { decoded = decodeURIComponent(basename); } catch { throw new Error('Invalid media path.'); }
  if (!decoded || decoded === '.' || decoded === '..' || /[\\/\p{Cc}]/u.test(decoded)
    || encodeURIComponent(decoded) !== basename) throw new Error('Invalid media path.');
  if (image.mimeType !== 'image/png' || !sha(image.sha256)
    || !integer(image.width, MAX_IMAGE_DIMENSION) || !image.width
    || !integer(image.height, MAX_IMAGE_DIMENSION) || !image.height
    || image.width * image.height > MAX_IMAGE_PIXELS
    || !integer(image.sizeBytes, MAX_IMAGE_BYTES) || !image.sizeBytes) throw new Error('Invalid media dimensions or bytes.');
  return { version: 1, state: 'ready', lease: {
    targetFingerprint: lease.targetFingerprint, leaseGeneration: lease.leaseGeneration,
    baseUrl: lease.baseUrl, url: lease.url, expiresAtMs: lease.expiresAtMs, resolvedAt: lease.resolvedAt,
  }, image: { mimeType: 'image/png', width: image.width, height: image.height, sizeBytes: image.sizeBytes, sha256: image.sha256 } };
}

// Synchronous public Standard Schema boundary; no copied SDK declarations or
// dependency on a supplier-specific transport implementation.
function schema<T>(decode: (raw: unknown) => T, json: () => Record<string, unknown>) {
  return { '~standard': { version: 1 as const, vendor: 'turn-result-images',
    validate(raw: unknown): { value: T } | { issues: { message: string }[] } {
      try { return { value: decode(raw) }; }
      catch { return { issues: [{ message: 'Invalid bounded image media data.' }] }; }
    },
    jsonSchema: { input: json, output: json },
  } };
}
const recordSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
const integerSchema = (maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum: 0, maximum });
const digestSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
export const ImageMediaInputSchema = schema(decodeImageMediaInput, () => recordSchema({
  version: { const: 1 }, identity: InputSchemas.identity.toJSONSchema({ io: 'input' }),
}));
export const ImageMediaOutputSchema = schema(decodeImageMediaOutput, () => ({ oneOf: [
  recordSchema({ version: { const: 1 }, state: { const: 'unavailable' }, reason: { type: 'string', pattern: '^[a-z0-9-]{1,128}$' } }),
  recordSchema({ version: { const: 1 }, state: { const: 'ready' },
    lease: recordSchema({ targetFingerprint: digestSchema, leaseGeneration: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
      baseUrl: { type: 'string', maxLength: 160 }, url: { type: 'string', maxLength: IMAGE_MEDIA_OUTPUT_BYTES },
      expiresAtMs: integerSchema(), resolvedAt: integerSchema() }),
    image: recordSchema({ mimeType: { const: 'image/png' }, width: integerSchema(MAX_IMAGE_DIMENSION),
      height: integerSchema(MAX_IMAGE_DIMENSION), sizeBytes: integerSchema(MAX_IMAGE_BYTES), sha256: digestSchema }),
  }),
] }));
