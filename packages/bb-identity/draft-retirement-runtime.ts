/** Internal provider-root lifetime; owns pending preservation only, never views or storage. */
import type { IdentityKey, Result } from './model.js';
import type { StateAddress } from './state.js';
import { err, ok } from './model-runtime.js';

export interface DraftRetirementScope {
  readonly address: StateAddress;
  readonly actor: IdentityKey;
  readonly schemaVersion: number;
}
export interface DraftRetirementOwner {
  begin(storage: object, scope: DraftRetirementScope, task: Promise<Result<void>>): void;
  /** Waits for settlement; persistence errors are reported by the retiring binding. */
  wait(storage: object, scope: DraftRetirementScope, signal?: AbortSignal): Promise<Result<void>>;
  dispose(): void;
}
const scopeKey = ({ address: a, actor, schemaVersion }: DraftRetirementScope) =>
  JSON.stringify([a.instanceId, a.pluginId, a.collection, a.recordId, a.owner, actor, schemaVersion]);

/** One explicit UI provider creates this; independent providers never share it implicitly. */
export function createDraftRetirementOwner(): DraftRetirementOwner {
  type Pending = Set<Promise<Result<void>>>;
  let partitions = new WeakMap<object, Map<string, Pending>>();
  const lifetime = new AbortController();
  const terminal = (signal?: AbortSignal): Result<void> | null => lifetime.signal.aborted
    ? err('disposed', 'Draft preservation owner is disposed.')
    : signal?.aborted ? err('cancelled', 'Draft preservation lookup was cancelled.') : null;
  const awaitPending = (tasks: readonly Promise<Result<void>>[], signal?: AbortSignal): Promise<Result<void>> => new Promise(resolve => {
    const finish = (result: Result<void>) => {
      lifetime.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); resolve(result);
    };
    const abort = () => finish(terminal(signal) ?? err('cancelled', 'Draft preservation lookup was cancelled.'));
    lifetime.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    const stopped = terminal(signal); if (stopped) { finish(stopped); return; }
    // A failed new checkpoint must not hide older durable recovery candidates.
    // The retiring binding reports that failure independently through its sink.
    void Promise.all(tasks).then(() => finish(terminal(signal) ?? ok(undefined)));
  });
  return {
    begin(storage, scope, task) {
      if (lifetime.signal.aborted) return;
      const key = scopeKey(scope);
      const scopes = partitions.get(storage) ?? new Map<string, Pending>(); partitions.set(storage, scopes);
      const pending = scopes.get(key) ?? new Set<Promise<Result<void>>>(); scopes.set(key, pending);
      const work = task.catch(() => err('unavailable', 'Draft preservation failed.', 'after-refresh'));
      pending.add(work);
      void work.then(() => {
        pending.delete(work);
        if (!pending.size) scopes.delete(key);
        if (!scopes.size) partitions.delete(storage);
      });
    },
    async wait(storage, scope, signal) {
      const key = scopeKey(scope);
      while (true) {
        const stopped = terminal(signal); if (stopped) return stopped;
        const pending = partitions.get(storage)?.get(key);
        if (!pending?.size) return ok(undefined);
        const result = await awaitPending([...pending], signal); if (!result.ok) return result;
      }
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(); partitions = new WeakMap();
    },
  };
}
