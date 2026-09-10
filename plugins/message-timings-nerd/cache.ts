// Bounded request coalescing. Invalidated in-flight work cannot restore a stale
// cache entry, and callers retry the new generation after success OR failure.
export function createCache<T>(load: (key: string) => Promise<T>, ttlMs = 2_000, limit = 32, concurrency = 2) {
  let active = 0;
  const waiting: (() => void)[] = [];
  async function limitedLoad(key: string) {
    if (active < concurrency) active++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try { return await load(key); }
    finally {
      const next = waiting.shift();
      if (next) next(); // Transfer the occupied slot directly to the next load.
      else active--;
    }
  }
  const entries = new Map<string, { value?: T; expires: number; generation: number; pending?: { generation: number; promise: Promise<T> } }>();
  function entry(key: string) {
    let value = entries.get(key);
    if (!value) {
      value = { expires: 0, generation: 0 };
      entries.set(key, value);
      // Evict settled entries only. In-flight entries are bounded by callers;
      // rejecting new unique work avoids repeated eviction/retry churn.
      if (entries.size > limit) {
        const victim = [...entries].find(([other, item]) => other !== key && !item.pending);
        if (victim) entries.delete(victim[0]);
        else { entries.delete(key); throw new Error("Too many timestamp requests; try again."); }
      }
    }
    return value;
  }
  return {
    invalidate(key: string) {
      const current = entries.get(key);
      if (!current) return;
      current.generation++;
      delete current.value;
      current.expires = 0;
      // Keep the old request occupying its slot until it settles. Deleting it
      // would allow overlapping work for the same key on every invalidation.
    },
    async get(key: string): Promise<T> {
      for (;;) {
        const current = entry(key);
        if (current.value !== undefined && current.expires > Date.now()) return current.value;
        if (!current.pending) {
          const generation = current.generation;
          const promise = limitedLoad(key).then(value => {
            if (entries.get(key) === current && current.generation === generation) {
              current.value = value; current.expires = Date.now() + ttlMs;
            }
            return value;
          }).finally(() => { delete current.pending; });
          current.pending = { generation, promise };
        }
        const pending = current.pending;
        try {
          const value = await pending.promise;
          if (entries.get(key) === current && pending.generation === current.generation) return value;
        } catch (error) {
          if (entries.get(key) === current && pending.generation === current.generation) throw error;
        }
      }
    },
  };
}
