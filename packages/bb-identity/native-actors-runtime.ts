/** Shared decoding of retained native actors; no live provider lookup. */
import { z } from 'zod';
import type { NativeActor, NativeMention, NativeSourceActor } from './native.js';
import type { Result } from './model.js';
import { err, externalPersonSnapshotCodec, ok } from './model-runtime.js';

const presentation = z.object({ displayName: z.string().min(1).max(512), handle: z.string().max(512).nullable(), avatarUrl: z.string().max(2048).nullable() });
const nativeActor = z.discriminatedUnion('evidence', [
  z.object({ evidence: z.literal('provider-verified'), identity: z.object({ kind: z.literal('person'), key: z.string().min(1).max(2048), issuer: z.string().min(1).max(512), subject: z.string().min(1).max(512) }), presentation }),
  z.object({ evidence: z.literal('machine'), identity: z.object({ kind: z.literal('machine'), key: z.string().min(1).max(2048), instanceId: z.string().min(1).max(256), hostId: z.string().max(256).nullable() }), presentation }),
]) satisfies z.ZodType<NativeActor>;
export const nativeMention = z.object({ identity: z.object({ kind: z.literal('person'), key: z.string().min(1).max(2048), issuer: z.string().min(1).max(512), subject: z.string().min(1).max(512) }), presentation, source: z.object({ pluginId: z.string().min(1).max(256), generation: z.string().min(1).max(256) }) }) satisfies z.ZodType<NativeMention>;
/** The shared model codec owns the assertion and branded identity validation. */
export function decodeSourceActors(value: unknown): Result<readonly (NativeSourceActor | null)[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.length > 256) return err('invalid-input', 'Malformed native actor snapshot.');
  const actors: (NativeSourceActor | null)[] = [];
  for (const actor of value) {
    if (actor === null) { actors.push(null); continue; }
    const external = externalPersonSnapshotCodec.decode(actor);
    if (external.ok) { actors.push(external.value); continue; }
    const native = nativeActor.safeParse(actor);
    if (!native.success) return err('invalid-input', 'Malformed native actor snapshot.');
    actors.push(native.data);
  }
  return ok(actors);
}
