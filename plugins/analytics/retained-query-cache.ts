/** Bounded, generation-keyed reuse for retained read models. No refresh side effects. */
export class RetainedQueryCache<T> {
  private readonly entries = new Map<string, { json: string; bytes: number }>();
  private bytes = 0;
  private generation: string | null = null;

  read(generation: string, parameters: unknown, load: () => T): T {
    if (generation !== this.generation) {
      this.entries.clear();
      this.bytes = 0;
      this.generation = generation;
    }
    // Callers pass their parsed schema, so optional/default keys have one order.
    const key = JSON.stringify(parameters);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return JSON.parse(cached.json) as T;
    }
    const value = load();
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(json, "utf8");
    if (bytes > 1024 * 1024) return value;
    while (this.entries.size >= 24 || this.bytes + bytes > 4 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { json, bytes });
    this.bytes += bytes;
    return value;
  }
}
