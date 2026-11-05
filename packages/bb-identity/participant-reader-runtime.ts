/** One request-scoped projection over public native membership and retained role evidence. */
import { z } from 'zod';
import type { NativeMention, NativeSourceActor } from './native.js';
import type { BbIdentityApi } from './bb.js';
import type { Contribution, Cursor, Disposable, IdentityError, Participant, ParticipantReader, ProvenanceReader, ReadOptions, Result, ThreadId } from './model.js';
import { err, idCodec, identityKeyCodec, ok, profileCodec } from './model-runtime.js';
import { decodeSourceActors, nativeMention } from './native-actors-runtime.js';

const NATIVE_PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 200;
const MAX_PAGES = 64;
const MAX_HISTORY_READS = 16384;
const MAX_BYTES = 8 * 1024 * 1024;
const roles: Participant['roles'] = ['author', 'editor', 'mentioned', 'interaction-resolver'];
const facetSchema = z.object({
  totalCount: z.number().int().nonnegative(), nextCursor: z.string().min(1).nullable(),
  profiles: z.array(z.object({ p6rPrincipalKey: z.string(), p6rIdentityKind: z.enum(['person', 'machine', 'external']), p6rDisplayName: z.string().min(1).max(512), p6rImageUrl: z.string().max(2048).nullable() })).max(100),
});
const eventSchema = z.object({
  id: z.string().min(1).max(256), threadId: z.string(), seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  type: z.literal('client/turn/requested'),
  data: z.object({ requestId: z.string().min(1).max(256), p6rAuthors: z.unknown().optional(), p6rEditors: z.unknown().optional(), p6rMentionedTargets: z.unknown().optional() }),
});
type RequestEvent = z.infer<typeof eventSchema>;
type RetainedRequest = { readonly id: string; readonly seq: number; readonly requestId: string;
  readonly authors: readonly (NativeSourceActor | null)[] | null;
  readonly editors: readonly (NativeSourceActor | null)[] | null;
  readonly mentions: readonly NativeMention[];
};
type Role = Participant['roles'][number];
type ParticipantEntry = { participant: Participant; roles: Set<Role>; firstByRole: Map<Role, number> };
type ParticipantPage = Extract<Awaited<ReturnType<ParticipantReader['list']>>, { ok: true }>['value'];
class ReadFailure extends Error {
  readonly detail: IdentityError;
  constructor(detail: IdentityError) { super(detail.message); this.detail = detail; }
}
function fail(code: IdentityError['code'], message: string, retry: IdentityError['retry'] = 'never'): never { throw new ReadFailure({ code, message, retry }); }
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new ReadFailure(result.error); return result.value; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Not a cache: each call has its own bounded traversal, source cutoff, and cancellation. */
export function createNativeParticipantReader(options: {
  readonly threads: () => BbIdentityApi['sdk']['threads']; readonly history: ProvenanceReader; readonly instanceId: string;
}): ParticipantReader & Disposable {
  const lifetime = new AbortController();
  const cancelled = (signal: AbortSignal) => { if (signal.aborted) fail(lifetime.signal.aborted ? 'disposed' : 'cancelled', 'Participant read was cancelled.'); };
  async function list(input: Parameters<ParticipantReader['list']>[0], readOptions?: ReadOptions): Promise<Result<ParticipantPage>> {
    if (!idCodec('thread').decode(input.threadId).ok || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) return err('invalid-input', 'Invalid participant query.');
    const signal = readOptions?.signal ? AbortSignal.any([lifetime.signal, readOptions.signal]) : lifetime.signal;
    try {
      cancelled(signal);
      const threads = options.threads();
      const facets = threads.facetParticipants, events = threads.events;
      if (typeof facets !== 'function' || typeof events?.list !== 'function') return err('unsupported', 'Retained participants require public threads.facetParticipants and threads.events.list.');
      // Race even a port that ignores cancellation. No late response launches another read.
      async function read<T>(operation: () => Promise<T>): Promise<T> {
        cancelled(signal);
        let abort = () => {};
        const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new ReadFailure({ code: lifetime.signal.aborted ? 'disposed' : 'cancelled', message: 'Participant read was cancelled.', retry: 'never' })); signal.addEventListener('abort', abort, { once: true }); });
        try { const value = await Promise.race([operation(), stopped]); cancelled(signal); return value; }
        finally { signal.removeEventListener('abort', abort); }
      }
      function eventPage(raw: unknown): RequestEvent[] {
        if (!Array.isArray(raw) || raw.length > NATIVE_PAGE_SIZE) fail('incompatible', 'Malformed native participant event page.');
        return raw.map(row => {
          const decoded = eventSchema.safeParse(row);
          if (!decoded.success || decoded.data.threadId !== input.threadId) fail('incompatible', 'Malformed native participant request event.');
          return decoded.data;
        });
      }
      async function head(): Promise<RequestEvent | null> {
        const page = eventPage(await read(() => events!.list({ threadId: input.threadId, types: ['client/turn/requested'], order: 'desc', limit: '1', signal })));
        if (page.length > 1) fail('incompatible', 'Native participant head exceeded its requested limit.');
        return page[0] ?? null;
      }
      let expectedRevision: string | null = null, offset = 0;
      let cutoff: number;
      const start = await head();
      if (input.cursor !== undefined) {
        if (!idCodec('cursor').decode(input.cursor).ok) fail('invalid-input', 'Invalid participant cursor.');
        const match = /^participants-v1:([a-f0-9]{64}):(\d+):(\d+):(\d+)$/.exec(input.cursor);
        if (!match || Number(match[4]) !== input.limit || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1) fail('invalid-input', 'Participant cursor does not match this query.');
        expectedRevision = match[1]!; cutoff = Number(match[2]); offset = Number(match[3]);
      } else cutoff = start?.seq ?? 0;

      let complete = true, bytes = 0, historyReads = 0, ordinal = 0;
      const evidence: unknown[] = [];
      function retain(value: unknown): void {
        bytes += new TextEncoder().encode(canonical(value)).byteLength;
        if (bytes > MAX_BYTES) fail('limit-exceeded', 'Participant evidence exceeds the 8 MiB read budget.');
        evidence.push(value);
      }
      const members = new Map<string, z.infer<typeof facetSchema>['profiles'][number]>();
      let facetCursor: string | undefined, total: number | undefined;
      const facetCursors = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) fail('limit-exceeded', 'Participant membership exceeds 64 pages.');
        const decoded = facetSchema.safeParse(await read(() => facets.call(threads, { threadId: input.threadId, pageSize: 100, ...(facetCursor ? { cursor: facetCursor } : {}), signal })));
        if (!decoded.success) fail('incompatible', 'Malformed native participant membership page.');
        const result = decoded.data;
        if (total !== undefined && total !== result.totalCount) complete = false;
        total = result.totalCount;
        for (const member of result.profiles) {
          if (!identityKeyCodec.decode(member.p6rPrincipalKey).ok) fail('incompatible', 'Malformed native participant member key.');
          if (members.has(member.p6rPrincipalKey)) { complete = false; continue; }
          members.set(member.p6rPrincipalKey, member);
          retain(['member', member]);
        }
        if (result.nextCursor === null) break;
        if (!result.profiles.length || facetCursors.has(result.nextCursor)) fail('incompatible', 'Native participant membership cursor did not advance.');
        facetCursors.add(result.nextCursor); facetCursor = result.nextCursor;
      }
      if (members.size !== total) complete = false;
      const participants = new Map<string, ParticipantEntry>();
      const pendingMentions = new Map<string, Contribution['mentionedPeople'][number]>();
      const mentionOrder = new Map<string, number>();
      function add(snapshot: { readonly identity: unknown; readonly presentation: unknown }, role: Role): void {
        const profile = profileCodec.decode({ ...snapshot, revision: 'retained-participant', status: 'historical' });
        if (!profile.ok) fail('incompatible', 'Malformed retained participant identity or presentation.');
        const { identity, presentation } = profile.value;
        const member = members.get(identity.key);
        if (!member) complete = false;
        if (member && identity.kind !== member.p6rIdentityKind) fail('incompatible', 'Participant identity kind disagrees with native membership.');
        let item = participants.get(identity.key);
        if (!item) {
          item = { participant: { identity: structuredClone(identity), presentation: structuredClone(presentation), roles: [] }, roles: new Set(), firstByRole: new Map() };
          participants.set(identity.key, item);
        } else if (canonical(item.participant.identity) !== canonical(identity)) fail('incompatible', 'Retained participant snapshots disagree on the identity for one member key.');
        item.participant = { ...item.participant, presentation: structuredClone(presentation) };
        item.roles.add(role);
        if (!item.firstByRole.has(role)) item.firstByRole.set(role, ordinal);
        ordinal++;
      }
      function contribute(item: Contribution): void {
        if (item.reference.threadId !== input.threadId) fail('incompatible', 'Participant contribution belongs to another thread.');
        if (item.author.kind === 'person' || item.author.kind === 'machine' || item.author.kind === 'external') add(item.author.actor, 'author');
        else complete = false;
        if (item.personAttribution) add(item.personAttribution, 'author');
        if (item.latestEditor) add(item.latestEditor, 'editor');
        for (const mention of item.mentionedPeople) {
          const previous = pendingMentions.get(mention.key);
          if (previous && canonical(previous) !== canonical(mention)) fail('incompatible', 'Contribution mentions disagree on the identity for one member key.');
          pendingMentions.set(mention.key, mention);
          if (!mentionOrder.has(mention.key)) mentionOrder.set(mention.key, ordinal);
          ordinal++;
        }
      }
      const nativeKeys = new Set<string>();
      const requests: RetainedRequest[] = [];
      let afterSeq = 0, sawCutoff = cutoff === 0;
      const eventIds = new Set<string>();
      for (let page = 0; cutoff > 0; page++) {
        if (page >= MAX_PAGES) fail('limit-exceeded', 'Participant requests exceed 64 pages.');
        const rows = eventPage(await read(() => events.list({ threadId: input.threadId, types: ['client/turn/requested'], order: 'asc', limit: String(NATIVE_PAGE_SIZE), afterSeq: String(afterSeq), beforeSeq: String(cutoff + 1), signal })));
        for (const row of rows) {
          if (row.seq <= afterSeq || row.seq > cutoff || eventIds.has(row.id)) fail('incompatible', 'Native participant events are not strictly ordered within their cutoff.');
          afterSeq = row.seq; eventIds.add(row.id); if (row.seq === cutoff) sawCutoff = true;
          const authors = structuredClone(unwrap(decodeSourceActors(row.data.p6rAuthors)));
          const editors = structuredClone(unwrap(decodeSourceActors(row.data.p6rEditors)));
          const mentions = z.array(nativeMention).max(256).optional().safeParse(row.data.p6rMentionedTargets);
          if (!mentions.success) fail('incompatible', 'Malformed native participant mentions.');
          const native = { id: row.id, seq: row.seq, requestId: row.data.requestId, authors: authors ?? null, editors: editors ?? null, mentions: mentions.data ?? [] };
          retain(['request', native]);
          requests.push(native);
          for (const actor of [...(authors ?? []), ...(editors ?? []), ...(mentions.data ?? [])]) if (actor) nativeKeys.add(actor.identity.key);
        }
        if (rows.length < NATIVE_PAGE_SIZE || afterSeq === cutoff) break;
      }
      if (!sawCutoff) complete = false;
      // Facets have no contribution/request correlation. Resolve any membership
      // not explained by native snapshots (including person editors), and every
      // external membership, through all retained request contributions.
      const membershipNeedsHistory = [...members.values()].some(member => member.p6rIdentityKind === 'external' || !nativeKeys.has(member.p6rPrincipalKey));
      for (const native of requests) {
        const { authors, editors, mentions } = native;
        for (const author of authors ?? []) if (author) add(author, 'author');
        for (const editor of editors ?? []) if (editor) add(editor, 'editor');
        for (const mention of mentions) add(mention, 'mentioned');
        const needsHistory = membershipNeedsHistory || !authors?.length || authors.some(actor => actor === null || actor.evidence === 'integration-asserted');
        if (!needsHistory) {
          // No public contribution correlation is present. Native facts remain
          // useful; skipping this independent source cannot establish completeness.
          complete = false;
          continue;
        }
        let cursor: Cursor | undefined, historyHadAuthor = false;
        const cursors = new Set<string>();
        for (;;) {
          if (++historyReads > MAX_HISTORY_READS) fail('limit-exceeded', 'Participant contribution reads exceed the bounded budget.');
          const historyResult = await read(() => options.history.contributions({ kind: 'native-event', threadId: input.threadId, eventId: native.id, limit: HISTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, { signal }));
          if (!historyResult.ok && (historyResult.error.code === 'unavailable' || historyResult.error.code === 'unsupported' || historyResult.error.code === 'not-found')) {
            retain(['history-error', native.id, historyResult.error.code]); complete = false; break;
          }
          const result = structuredClone(unwrap(historyResult));
          retain(['history', native.id, result]);
          if (result.status === 'pending' || result.status === 'unavailable') { complete = false; break; }
          if (result.items.length > HISTORY_PAGE_SIZE || (result.nextCursor === null) !== (result.traversal === 'complete')) fail('incompatible', 'Malformed participant contribution pagination.');
          if (result.status !== 'known' || result.missing.length) complete = false;
          for (const item of result.items) {
            contribute(item);
            if (item.author.kind === 'person' || item.author.kind === 'machine' || item.author.kind === 'external') historyHadAuthor = true;
          }
          if (result.nextCursor === null) break;
          if (!result.items.length || cursors.has(result.nextCursor)) fail('incompatible', 'Participant contribution cursor did not advance.');
          cursors.add(result.nextCursor); cursor = result.nextCursor;
        }
        if ((!authors?.length || authors.some(actor => actor === null)) && !historyHadAuthor) complete = false;
      }
      const end = await head();
      if (start?.id !== end?.id || start?.seq !== end?.seq || end?.seq !== (cutoff || undefined)) complete = false;
      for (const [key, identity] of pendingMentions) {
        const item = participants.get(key);
        if (!item) { complete = false; continue; }
        if (canonical(item.participant.identity) !== canonical(identity)) fail('incompatible', 'Contribution mention disagrees with the retained identity for its member key.');
        item.roles.add('mentioned');
        item.firstByRole.set('mentioned', Math.min(item.firstByRole.get('mentioned') ?? Infinity, mentionOrder.get(key)!));
      }
      if (participants.size !== members.size) complete = false;
      const priority = (item: ParticipantEntry) => roles.findIndex(role => item.roles.has(role));
      const items = [...participants.values()].sort((a, b) => {
        const aRank = priority(a), bRank = priority(b);
        return aRank - bRank || a.firstByRole.get(roles[aRank]!)! - b.firstByRole.get(roles[bRank]!)!;
      }).map(item => ({ ...item.participant, roles: roles.filter(role => item.roles.has(role)) }));
      const coverage = complete ? 'complete-history' : 'partial-history';
      const hash = await digest([options.instanceId, input.threadId, cutoff, evidence, items, coverage]);
      cancelled(signal);
      if (expectedRevision !== null && expectedRevision !== hash) return err('conflict', 'Participant evidence changed; restart pagination.', 'after-refresh');
      if (offset > items.length) return err('invalid-input', 'Participant cursor is outside this retained result.');
      const revision = unwrap(idCodec('revision').decode(`participants-v1:${hash}`));
      const nextCursor = offset + input.limit < items.length ? unwrap(idCodec('cursor').decode(`participants-v1:${hash}:${cutoff}:${offset + input.limit}:${input.limit}`)) : null;
      return ok({ items: items.slice(offset, offset + input.limit), nextCursor, revision, coverage });
    } catch (error) {
      if (signal.aborted) return err(lifetime.signal.aborted ? 'disposed' : 'cancelled', 'Participant read was cancelled.');
      return error instanceof ReadFailure ? { ok: false, error: error.detail } : err('unavailable', 'Native participant sources are unavailable.', 'after-reconnect');
    }
  }
  return {
    list,
    async previews(input, readOptions) {
      if (!Array.isArray(input.threadIds) || input.threadIds.length > 64 || input.threadIds.some(thread => !idCodec('thread').decode(thread).ok) || !Number.isInteger(input.perThreadLimit) || input.perThreadLimit < 1 || input.perThreadLimit > 100) return err('invalid-input', 'Invalid participant preview query.');
      const previews: { threadId: ThreadId; participants: readonly Participant[]; hasMore: boolean; coverage: ParticipantPage['coverage']; revision: ParticipantPage['revision'] }[] = [];
      for (const threadId of input.threadIds) {
        const page = await list({ threadId, limit: input.perThreadLimit }, readOptions);
        if (!page.ok) return page;
        previews.push({ threadId, participants: page.value.items, hasMore: page.value.nextCursor !== null, coverage: page.value.coverage, revision: page.value.revision });
      }
      if (lifetime.signal.aborted) return err('disposed', 'Participant reader is disposed.');
      if (readOptions?.signal?.aborted) return err('cancelled', 'Participant read was cancelled.');
      return ok(previews);
    },
    dispose() { lifetime.abort(); },
  };
}
