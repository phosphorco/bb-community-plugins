/** Request-bound server mechanics shared by singleton and enhanced host adapters. */
import type {
  ActorReference, ActorSnapshot, Codec, IdentityKey, IdentityProfile, Json, OperationId, PersonReference,
  RequestExpectation, Result, SendInput,
} from './model.js';
import { err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import type {
  ExternalAuthorInput, HostInvalidation, IdentityHost, LiveRequest, ServerSession,
} from './host.js';
import type {
  CommitScope, CommitValidator, IdentityEndpoint, IdentityServer, PersonRequest,
  ReadTargetRequest, ResolvedTarget, TargetPolicy, TargetRequest, TargetSnapshot,
  WriteTargetRequest,
} from './server.js';

function sameExpectation(actor: IdentityKey, stamp: string, expectedActor: IdentityKey, expectedStamp: string): Result<void> {
  return actor === expectedActor && stamp === expectedStamp
    ? ok(undefined)
    : err('stale-context', 'The request actor or session changed.', 'after-refresh');
}

function isPerson(value: IdentityProfile['identity']): value is Extract<IdentityProfile['identity'], { kind: 'person' | 'default-user' }> {
  return value.kind === 'person' || value.kind === 'default-user';
}

function freezePerson(input: PersonReference): PersonReference {
  return input.kind === 'person'
    ? Object.freeze({ kind: 'person' as const, key: input.key, issuer: input.issuer, subject: input.subject })
    : Object.freeze({ kind: 'default-user' as const, key: input.key, instanceId: input.instanceId });
}

function freezeActorReference(input: ActorReference): ActorReference {
  return input.kind === 'machine'
    ? Object.freeze({ kind: 'machine' as const, key: input.key, instanceId: input.instanceId, hostId: input.hostId })
    : freezePerson(input);
}

function freezeActor(input: ActorSnapshot & { readonly identity: ActorReference }): ActorSnapshot & { readonly identity: ActorReference } {
  return Object.freeze({
    identity: freezeActorReference(input.identity),
    presentation: Object.freeze({
      displayName: input.presentation.displayName,
      handle: input.presentation.handle,
      avatarUrl: input.presentation.avatarUrl,
    }),
    evidence: input.evidence,
  });
}

function freezeExpected(input: RequestExpectation): RequestExpectation {
  return Object.freeze({ actor: input.actor, session: input.session });
}

/**
 * Captures target facts at request time. CommitValidator rechecks those facts
 * against the supplied address and live request signal at the synchronous
 * storage boundary.
 */
export function createIdentityServer<R, T, I>(options: { readonly host: IdentityHost<R, T, I> }): IdentityServer<R, T, I> {
  const { host } = options;
  let disposed = false;
  const dispose = () => { disposed = true; };

  const commits: CommitValidator = {
    boundary: 'same-process-synchronous',
    validate(target, scope) {
      if (typeof target !== 'object' || target === null || target.intent !== 'write'
        || typeof target.snapshot !== 'function' || !(target.signal instanceof AbortSignal)) {
        return err('invalid-input', 'Write target does not have write intent.');
      }
      if (disposed || target.signal.aborted) return err('expired', 'The request context is no longer live.');
      const addressIsConcrete = scope.collection.length > 0 && scope.recordId.length > 0
        && Number.isInteger(scope.schemaVersion) && scope.schemaVersion >= 0;
      try {
        const snapshot: TargetSnapshot = target.snapshot();
        const capturedActor = snapshot.actor.identity.key;
        const capturedSubject = snapshot.subject.key;
        const capturedExpected = snapshot.expected;
        const capturedFactsAreConsistent = capturedExpected.actor === capturedActor;
        return addressIsConcrete && scope.instanceId === host.instanceId && scope.pluginId === host.pluginId
          && capturedFactsAreConsistent
          && scope.subject === capturedSubject
          && scope.expected.actor === capturedExpected.actor
          && scope.expected.session === capturedExpected.session
          ? ok(undefined)
          : err('stale-context', 'Target does not match this live commit scope.', 'after-refresh');
      } catch {
        return err('invalid-input', 'Write target snapshot is unavailable.');
      }
    },
  };

  async function issueTarget(live: LiveRequest, request: PersonRequest<I>, input: TargetRequest): Promise<Result<ResolvedTarget<'read'> | ResolvedTarget<'write'>>> {
    if (request.signal.aborted) return err('expired', 'The request context is no longer live.');
    const currentRequest = live.validate(request.expected);
    if (!currentRequest.ok) return currentRequest;
    const actor = freezeActor(request.actor);
    let subject: ActorReference = freezeActorReference(actor.identity);
    if (input.selection.kind === 'person') {
      if (input.policy.kind === 'self-only') return err('unsupported', 'This operation only supports the acting person.');
      const profiles = await host.directory.getMany({ keys: [input.selection.key] });
      if (!profiles.ok) return profiles;
      const found = profiles.value[0];
      if (!found || found.status !== 'found' || !isPerson(found.profile.identity)) return err('not-found', 'Selected person was not found.');
      subject = freezePerson(found.profile.identity);
    }
    if (input.intent === 'write') {
      const current = sameExpectation(request.actor.identity.key, request.expected.session, input.expected.actor, input.expected.session);
      if (!current.ok) return current;
      if (input.expectedSubject !== subject.key) return err('stale-owner', 'Selected subject changed.', 'after-refresh');
    }
    const expected = freezeExpected({ actor: actor.identity.key, session: request.expected.session });
    const snapshot: TargetSnapshot = Object.freeze({
      actor,
      subject,
      expected,
    });
    const target = Object.freeze({
      intent: input.intent,
      snapshot: () => snapshot,
      signal: request.signal,
    }) as ResolvedTarget<'read'> | ResolvedTarget<'write'>;
    return ok(target);
  }

  const server: IdentityServer<R, T, I> = {
    instanceId: host.instanceId,
    directory: host.directory,
    participants: host.participants,
    history: host.history,
    commits,
    session: (context, readOptions) => host.session(context, readOptions),
    selfProfile: (context, readOptions) => host.selfProfile(context, readOptions),
    subscribe: (listener) => host.subscribe(listener),
    async personRequest(context, readOptions) {
      if (disposed) return err('disposed', 'Identity server is disposed.');
      const opened = await host.openPersonRequest(context, readOptions);
      if (!opened.ok) return opened;
      const live = opened.value;
      let released = false;
      let request!: PersonRequest<I>;
      async function target(input: ReadTargetRequest): Promise<Result<ResolvedTarget<'read'>>>;
      async function target(input: WriteTargetRequest): Promise<Result<ResolvedTarget<'write'>>>;
      async function target(input: TargetRequest): Promise<Result<ResolvedTarget<'read'> | ResolvedTarget<'write'>>> {
        return issueTarget(live, request, input);
      }
      request = {
        actor: live.session.actor,
        expected: { actor: live.session.actor.identity.key, session: live.session.stamp },
        capabilities: live.session.capabilities,
        signal: live.signal,
        target,
        async send(input, sendOptions) {
          const valid = live.validate(input.expected);
          if (!valid.ok) return { status: 'rejected', error: valid.error };
          return host.send(live, input, sendOptions);
        },
        async callPlugin(input, callOptions) {
          const valid = live.validate(request.expected);
          if (!valid.ok) return valid;
          try {
            return input.output.decode(await host.forward(live, input.pluginId, input.method, input.payload));
          } catch {
            return err('unavailable', 'Destination plugin call failed.', callOptions?.signal?.aborted ? 'never' : 'after-reconnect');
          }
        },
        dispose() {
          if (released) return;
          released = true;
          live.release();
        },
      };
      return ok(request);
    },
    toolProvenance: (context) => disposed ? Promise.resolve(err('disposed', 'Identity server is disposed.')) : host.readToolProvenance(context),
    sendExternal: (author: ExternalAuthorInput, input: SendInput<I>, readOptions) => disposed
      ? Promise.resolve({ status: 'rejected' as const, error: { code: 'disposed' as const, message: 'Identity server is disposed.', retry: 'never' as const } })
      : host.sendExternal(author, input, readOptions),
    lookupOperation: (operationId: OperationId, readOptions) => disposed
      ? Promise.resolve(err('disposed', 'Identity server is disposed.')) : host.lookupOperation(operationId, readOptions),
    dispose,
  };
  return server;
}

/** Thin endpoint: all request identity stays in the server/host path, never JSON input. */
export function createIdentityEndpoint<R, T, I>(options: {
  readonly server: IdentityServer<R, T, I>;
  readonly publish: (event: import('./client.js').ClientInvalidation) => void;
}): IdentityEndpoint<R> {
  let disposed = false;
  let stop: (() => void) | null = null;
  const dispose = () => { disposed = true; const unsubscribe = stop; stop = null; unsubscribe?.(); };
  const subscribed = options.server.subscribe((event) => {
    if (disposed) return;
    try {
      if (event.kind === 'directory') {
        const keys = event.keys.map((key) => identityKeyCodec.decode(key));
        options.publish({ kind: 'directory', keys: keys.every((key) => key.ok) ? keys.map((key) => (key as { ok: true; value: typeof key.value }).value) : [], revision: null });
      } else if (event.kind === 'participants') {
        const ids = event.threadIds.map((id) => idCodec('thread').decode(id));
        if (ids.every((id) => id.ok)) options.publish({ kind: 'participants', threadIds: ids.map((id) => (id as { ok: true; value: typeof id.value }).value) });
      } else if (event.kind === 'session') options.publish(event.reason === undefined ? { kind: 'session' } : { kind: 'session', reason: event.reason });
      else if (event.kind === 'reconnected' || event.kind === 'disconnected') options.publish({ kind: event.kind });
      else if (event.kind === 'disposed') { dispose(); options.publish({ kind: 'disconnected' }); }
    } catch { /* Host mutation callbacks must not be failed by downstream publication. */ }
  });
  if (disposed) subscribed(); else stop = subscribed;
  const reject = <V>(): Promise<Result<V>> => Promise.resolve(err('disposed', 'Identity endpoint is disposed.'));
  const fence = async <V>(work: Promise<Result<V>>): Promise<Result<V>> => {
    try { const result = await work; return disposed ? err('disposed', 'Identity endpoint is disposed.') : result; }
    catch { return err(disposed ? 'disposed' : 'unavailable', disposed ? 'Identity endpoint is disposed.' : 'Identity endpoint read failed.'); }
  };
  return {
    bootstrap(context, readOptions) { return disposed ? reject() : fence(options.server.session(context, readOptions).then(ok)); },
    selfProfile(context, readOptions) { return disposed ? reject() : fence(options.server.selfProfile(context, readOptions)); },
    search(context, input, readOptions) { return disposed ? reject() : fence(options.server.directory.search(input, readOptions)); },
    profiles(context, input, readOptions) { return disposed ? reject() : fence(options.server.directory.getMany(input, readOptions)); },
    participants(context, input, readOptions) { return disposed ? reject() : fence(options.server.participants.list(input, readOptions)); },
    participantPreviews(context, input, readOptions) { return disposed ? reject() : fence(options.server.participants.previews(input, readOptions)); },
    dispose,
  };
}
