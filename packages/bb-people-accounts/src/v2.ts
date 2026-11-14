import { z } from 'zod';
import { idCodec, identityKeyCodec, type Codec, type IdentityReference, type Json } from '@phosphorco/bb-identity/model';
import type { StateResource } from '@phosphorco/bb-identity/state';

/** Associations only. No actor resolution, credentials, defaults or permission claims. */
export const PROTOCOL_V2 = 'bb-people-accounts' as const;
export const METHODS_V2 = Object.freeze({
  describe: 'peopleAccountsDescribe', list: 'peopleAccountsV2IdentitiesList',
  get: 'peopleAccountsV2IdentitiesGet', links: 'peopleAccountsV2LinksGet', find: 'peopleAccountsV2LinksFind',
});
export const LIMITS_V2 = Object.freeze({
  subjectBytes: 2048, queryBytes: 320, displayBytes: 128, cursorBytes: 2048,
  batch: 64, page: 50, links: 128, recordBytes: 192 * 1024, responseBytes: 256 * 1024,
  concurrency: 4, describeMs: 2000, sliceMs: 5000, callMs: 5000, suppliers: 32,
});
export const rpcFailureV2Schema = z.object({ ok: z.literal(false), error: z.object({ kind: z.enum(['absent', 'unavailable', 'incompatible', 'limit-exceeded', 'timeout', 'cancelled', 'disposed']) }) });
/** Read replies carry fixed errors as data; RPC transports need not preserve custom Error subclasses. */
export function rpcResultV2Schema<T>(value: z.ZodType<T>) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }), rpcFailureV2Schema]);
}
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const text = (max: number) => z.string().refine(s => s.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(s) && bytes(s) <= max, 'Invalid bounded text');
export const personKeyV2Schema = z.unknown().transform((value, ctx) => {
  const result = identityKeyCodec.decode(value);
  if (result.ok) return result.value;
  ctx.addIssue({ code: 'custom', message: result.error.message }); return z.NEVER;
});
export const pluginIdV2Schema = z.unknown().transform((value, ctx) => {
  const result = idCodec('plugin').decode(value);
  if (result.ok) return result.value;
  ctx.addIssue({ code: 'custom', message: result.error.message }); return z.NEVER;
});
export type ExternalLocator = Pick<Extract<IdentityReference, { kind: 'external' }>, 'pluginId' | 'subject'>;
const locatorShape = { pluginId: pluginIdV2Schema, subject: text(LIMITS_V2.subjectBytes) };
export const externalLocatorSchema = z.strictObject(locatorShape);
const locatorOutput = z.object(locatorShape);
export const locatorKey = (identity: ExternalLocator): string => JSON.stringify([identity.pluginId, identity.subject]);
const linkShape = { id: text(256), identity: externalLocatorSchema };
export const linkV2Schema = z.strictObject(linkShape);
const linkOutput = z.object({ ...linkShape, identity: locatorOutput });
export type LinkV2 = z.infer<typeof linkV2Schema>;
function distinctLinks(links: readonly LinkV2[]): boolean {
  return new Set(links.map(l => l.id)).size === links.length && new Set(links.map(l => locatorKey(l.identity))).size === links.length;
}
export const linksRecordSchema = z.strictObject({ links: z.array(linkV2Schema).max(LIMITS_V2.links) })
  .refine(v => distinctLinks(v.links), 'Duplicate link id or identity')
  .refine(v => bytes(JSON.stringify(v)) <= LIMITS_V2.recordBytes, 'Link record exceeds its byte limit');
export type LinksRecord = z.infer<typeof linksRecordSchema>;
export const linksCodec: Codec<LinksRecord> = {
  decode(value) {
    const parsed = linksRecordSchema.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: { code: 'invalid-input', message: 'Invalid links record', retry: 'never' } };
  },
  encode(value): Json { return linksRecordSchema.parse(value); },
};
/** Feature storage and transactions stay with the host; this descriptor opens no connection. */
export function createLinksResource(pluginId: string): StateResource<LinksRecord> {
  return { pluginId: pluginIdV2Schema.parse(pluginId), definition: {
    collection: 'people-account-links-v2', schemaVersion: 1, codec: linksCodec,
    initialValue: () => ({ links: [] }),
    equal: (a, b) => JSON.stringify(linksCodec.encode(a)) === JSON.stringify(linksCodec.encode(b)),
  } };
}

const presentationInput = z.strictObject({ displayName: text(LIMITS_V2.displayBytes), handle: text(LIMITS_V2.queryBytes).nullable() });
const identityOutput = z.object({ identity: locatorOutput, presentation: z.object(presentationInput.shape) });
export const identityV2Schema = z.strictObject({ identity: externalLocatorSchema, presentation: presentationInput });
export type IdentityV2 = z.infer<typeof identityV2Schema>;
const revision = text(256);
const stateVersion = z.object({ epoch: revision, sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const cursor = text(LIMITS_V2.cursorBytes);
const coverage = z.enum(['complete', 'partial']);
const continuationShape = { revision: revision.optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(LIMITS_V2.page) };
const continuation = (v: { cursor?: string | undefined; revision?: string | undefined }) => v.cursor === undefined || v.revision !== undefined;
export const listInputV2Schema = z.strictObject({ version: z.literal(2), query: z.string().refine(s => !/[\u0000-\u001f\u007f]/u.test(s) && bytes(s) <= LIMITS_V2.queryBytes), ...continuationShape })
  .refine(continuation, 'Continuation needs a revision');
export const getInputV2Schema = z.strictObject({ version: z.literal(2), subjects: z.array(text(LIMITS_V2.subjectBytes)).min(1).max(LIMITS_V2.batch) });
export const linksInputV2Schema = z.strictObject({ version: z.literal(2), personKeys: z.array(personKeyV2Schema).min(1).max(LIMITS_V2.batch) });
export const findInputV2Schema = z.strictObject({ version: z.literal(2), identity: externalLocatorSchema, ...continuationShape })
  .refine(continuation, 'Continuation needs a revision');
export const listOutputV2Schema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(2), status: z.literal('page'), query: z.string(), revision, items: z.array(identityOutput).max(LIMITS_V2.page), nextCursor: cursor.nullable(), coverage }),
  z.object({ version: z.literal(2), status: z.enum(['conflict', 'unavailable']), query: z.string() }),
]);
export const getOutputV2Schema = z.object({ version: z.literal(2), results: z.array(z.discriminatedUnion('status', [
  z.object({ subject: text(LIMITS_V2.subjectBytes), status: z.literal('found'), value: identityOutput }),
  z.object({ subject: text(LIMITS_V2.subjectBytes), status: z.enum(['missing', 'unavailable']) }),
])).max(LIMITS_V2.batch) });
export const linksOutputV2Schema = z.object({ version: z.literal(2), results: z.array(z.discriminatedUnion('status', [
  z.object({ personKey: personKeyV2Schema, status: z.literal('found'), version: stateVersion, links: z.array(linkOutput).max(LIMITS_V2.links) }).refine(v => distinctLinks(v.links), 'Duplicate link'),
  z.object({ personKey: personKeyV2Schema, status: z.enum(['missing', 'unavailable']) }),
])).max(LIMITS_V2.batch) });
export const findOutputV2Schema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(2), status: z.literal('page'), identity: locatorOutput, revision,
    links: z.array(z.object({ personKey: personKeyV2Schema, id: text(256) })).max(LIMITS_V2.page), nextCursor: cursor.nullable(), coverage }),
  z.object({ version: z.literal(2), status: z.enum(['conflict', 'unavailable']), identity: locatorOutput }),
]);
export type ListInputV2 = z.infer<typeof listInputV2Schema>;
export type ListOutputV2 = z.infer<typeof listOutputV2Schema>;
export type GetInputV2 = z.infer<typeof getInputV2Schema>;
export type GetOutputV2 = z.infer<typeof getOutputV2Schema>;
export type LinksInputV2 = z.infer<typeof linksInputV2Schema>;
export type LinksOutputV2 = z.infer<typeof linksOutputV2Schema>;
export type FindInputV2 = z.infer<typeof findInputV2Schema>;
export type FindOutputV2 = z.infer<typeof findOutputV2Schema>;

export const capabilitiesV2Schema = z.object({ identities: z.boolean(), links: z.boolean() }).refine(c => c.identities || c.links, 'No capabilities');
export type CapabilitiesV2 = z.infer<typeof capabilitiesV2Schema>;
export const describeEnvelopeV2Schema = z.object({ protocol: z.literal(PROTOCOL_V2), versions: z.array(z.number().int().min(1).max(1000)).min(1).max(16), capabilities: z.unknown() });
export function negotiatePeopleAccounts(value: unknown): { status: 'ready'; capabilities: CapabilitiesV2 } | { status: 'incompatible'; reason: 'version' | 'schema' } {
  const envelope = describeEnvelopeV2Schema.safeParse(value);
  if (!envelope.success) return { status: 'incompatible', reason: 'schema' };
  if (!envelope.data.versions.includes(2)) return { status: 'incompatible', reason: 'version' };
  const capabilities = capabilitiesV2Schema.safeParse(envelope.data.capabilities);
  return capabilities.success ? { status: 'ready', capabilities: capabilities.data } : { status: 'incompatible', reason: 'schema' };
}
