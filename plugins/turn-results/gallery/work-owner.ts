import { untilAborted } from './lifetime.ts';
import type { GalleryAnchor, GalleryTimelinePort } from './anchors.ts';

/** Existing window scheduler, independent of result schemas/rendering. No fact store. */
export const GALLERY_WORK_LIMITS = Object.freeze({ lanes: 2, historyQueue: 128 });
export interface GalleryTurnWork {
  key: string; threadId: string; anchor: GalleryAnchor; refs: number; visible: number;
  dirty: boolean; controller: AbortController | null; phase: 'read' | 'source'; speculative: number;
}
interface LatestJoin { scope: object; client: object; key: string; current(): boolean }
interface HistoryGroup { controller: AbortController; members: HistoryRead[] }
interface HistoryRead {
  threadId: string; priority: boolean; speculative: boolean; interruptible: boolean; join: LatestJoin | undefined;
  live(): boolean; policy(): boolean; start(): void; cancel(reason?: unknown): void; interrupt(): void;
  attach(group: HistoryGroup): void; dispatched(): void; settle(value: unknown, failure?: unknown): void;
}
type Work = GalleryTurnWork | HistoryRead;
export function createGalleryWorkOwner() {
  let active = true, visible = !document.hidden, running = 0, scheduled = false;
  const queue = new Map<string, Set<Work>>(), runningThreads = new Map<string, () => boolean>();
  const speculativeThreads = new Set<string>(), historyReads = new Set<HistoryRead>();
  const retainedCalls = new WeakMap<AbortSignal, Set<Promise<unknown>>>();
  let workDrain: Promise<void> | null = null, finishWorkDrain: (() => void) | null = null;
  let startTurn: ((entry: GalleryTurnWork) => void) | null = null;
  const drainedWork = () => { if (!running && finishWorkDrain) { const done = finishWorkDrain; finishWorkDrain = null; workDrain = null; done(); } };
  function enqueue(entry: GalleryTurnWork) {
    if (!entry.refs || !entry.visible || !entry.dirty || !active || !visible) return;
    const thread = queue.get(entry.anchor.threadId) ?? new Set<Work>();
    thread.add(entry); queue.set(entry.anchor.threadId, thread); schedule();
  }
  function unqueue(entry: Work) {
    const pending = queue.get(entry.threadId); pending?.delete(entry);
    if (!pending?.size) queue.delete(entry.threadId);
  }
  function dequeue(): Work | null {
    const threads = [...queue];
    const urgent = ([, entries]: typeof threads[number]) => [...entries].some(entry => 'start' in entry && entry.priority && entry.live());
    // Open is first; retained pages/history/Media then share FIFO ahead of
    // optional source work. A short turn's enrichment cannot consume the
    // original deadline of a sibling's still-incomplete retained collection.
    const speculative = (entry: Work) => 'start' in entry ? entry.speculative : entry.visible <= entry.speculative;
    const useful = (entry: Work) => !speculative(entry) && ('start' in entry || entry.phase === 'read');
    const usefulThread = ([, entries]: typeof threads[number]) => [...entries].some(entry => useful(entry)
      && ('start' in entry ? entry.live() : entry.refs && entry.visible && entry.dirty && !entry.controller));
    const foreground = ([, entries]: typeof threads[number]) => [...entries].some(entry => !speculative(entry));
    for (const [threadId, entries] of [...threads.filter(urgent), ...threads.filter(entry => !urgent(entry) && usefulThread(entry)),
      ...threads.filter(entry => !urgent(entry) && !usefulThread(entry) && foreground(entry)),
      ...threads.filter(entry => !urgent(entry) && !foreground(entry))]) {
      if (runningThreads.has(threadId)) continue;
      queue.delete(threadId);
      let next: Work | null = null;
      const priority = [...entries].find(entry => 'start' in entry && entry.priority && entry.live());
      for (const entry of priority ? [priority, ...[...entries].filter(entry => entry !== priority)]
        : [...[...entries].filter(useful), ...[...entries].filter(entry => !useful(entry) && !speculative(entry)), ...[...entries].filter(speculative)]) {
        entries.delete(entry);
        if ('start' in entry ? entry.live() : entry.refs && entry.visible && entry.dirty && !entry.controller) { next = entry; break; }
      }
      if (entries.size) queue.set(threadId, entries);
      if (next) return next;
    }
    return null;
  }
  function schedule() {
    if (!active || !visible || scheduled) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump() {
    if (!active || !visible) return;
    while (running < GALLERY_WORK_LIMITS.lanes) {
      const entry = dequeue(); if (!entry) break;
      running++;
      if ('start' in entry) {
        if (entry.speculative) speculativeThreads.add(entry.threadId);
        runningThreads.set(entry.threadId, () => {
          if (!entry.speculative || !entry.interruptible) return false; entry.interrupt(); return true;
        });
        entry.start();
      } else startTurn!(entry);
    }
  }
  function readScope<T>(threadId: string, signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>, priority = false,
    speculative: boolean | (() => boolean) = false, interruptible = true, join?: LatestJoin, onDispatch?: () => void): Promise<{ state: 'ready'; value: T } | { state: 'capacity' }> {
    signal.throwIfAborted();
    if (!active || !visible) return Promise.reject(Error('Gallery read retired.'));
    // Every consumer remains charged, including detached members of a raw
    // cohort that has not settled. Sharing cannot create extra queue capacity.
    if (historyReads.size >= GALLERY_WORK_LIMITS.historyQueue) return Promise.resolve({ state: 'capacity' });
    return new Promise((resolve, reject) => {
      let live = true, group: HistoryGroup | null = null;
      const cleanup = () => signal.removeEventListener('abort', callerAbort);
      const policy = () => typeof speculative === 'function' ? speculative() : speculative;
      const eligible = (entry: HistoryRead) => { try { return !!entry.join?.current(); } catch { return false; } };
      const cancel = (reason?: unknown) => {
        if (!live) return; live = false; cleanup(); reject(reason ?? Error('Gallery read retired.'));
        if (!group) { unqueue(work); historyReads.delete(work); }
        else if (!group.members.some(member => member.live())) group.controller.abort(reason);
      };
      const callerAbort = () => cancel(signal.reason);
      const work: HistoryRead = { threadId, priority, interruptible, join, live: () => live,
        policy, get speculative() { return group ? group.members.filter(member => member.live()).every(member => member.policy()) : policy(); },
        cancel, interrupt() {
          if (!group) { cancel(); return; }
          for (const member of group.members) member.cancel();
          group.controller.abort();
        },
        attach(value) { group = value; },
        dispatched() { if (live) { try { onDispatch?.(); } catch (error) { cancel(error); } } },
        settle(value, failure) {
          if (!live) return; live = false; cleanup();
          if (failure !== undefined) reject(failure); else resolve({ state: 'ready', value: value as T });
        },
        start() {
          const owned: HistoryGroup = { controller: new AbortController(), members: [work] };
          // Only work still queued at THIS dispatch boundary can join. A
          // started/settled item is never searched or made matchable again.
          if (!priority && join && eligible(work)) for (const candidate of [...(queue.get(threadId) ?? [])]) {
            if (!('start' in candidate) || candidate.priority || !candidate.live() || !candidate.join
              || candidate.join.scope !== join.scope || candidate.join.client !== join.client || candidate.join.key !== join.key || !eligible(candidate)) continue;
            unqueue(candidate); owned.members.push(candidate);
          }
          for (const member of owned.members) member.attach(owned);
          const controller = owned.controller;
          const call = Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            // A reset may run between grouping and this actual SDK microtask.
            if (owned.members.length > 1) for (const member of owned.members) if (!eligible(member)) member.cancel(Error('Shared history reader retired.'));
            controller.signal.throwIfAborted();
            for (const member of owned.members) member.dispatched();
            controller.signal.throwIfAborted(); return read(controller.signal);
          });
          void untilAborted(call, controller.signal).then(value => {
            for (const member of owned.members) {
              if (owned.members.length > 1 && !eligible(member)) member.cancel(Error('Shared history reader retired.'));
              else member.settle(value);
            }
          }, failure => { for (const member of owned.members) member.settle(undefined, failure ?? Error('Gallery read failed.')); }).finally(async () => {
            await call.catch(() => {});
            await Promise.allSettled([...(retainedCalls.get(controller.signal) ?? [])]);
            for (const member of owned.members) historyReads.delete(member);
            complete(threadId);
          });
        } };
      signal.addEventListener('abort', callerAbort, { once: true }); historyReads.add(work);
      const pending = queue.get(threadId) ?? new Set<Work>(); pending.add(work); queue.set(threadId, pending); schedule();
      if (priority || !work.speculative) {
        const sameThread = runningThreads.get(threadId);
        if (sameThread && (priority || speculativeThreads.has(threadId))) sameThread();
        else if (running >= GALLERY_WORK_LIMITS.lanes) {
          for (const [id, yieldRead] of runningThreads) if ((priority || speculativeThreads.has(id)) && yieldRead()) break;
        }
      }
    });
  }
  function readTimeline(input: Parameters<GalleryTimelinePort['timeline']>[0], client: GalleryTimelinePort,
    options: { scope: object; current(): boolean; dispatched?(): void; speculative?: boolean }) {
    const { signal, ...wire } = input;
    // Only exact, plain, known latest wire data is joinable. In particular an
    // explicitly present undefined cursor is not an omitted cursor. No generic
    // JSON/schema dependency or weakening of the queued-only cohort boundary.
    const fields = ['deferContent', 'includeNestedRows', 'segmentLimit', 'threadId'];
    const keys = Object.keys(input).filter(key => key !== 'signal').sort();
    const plain = Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null;
    const joinable = plain && Object.getOwnPropertySymbols(input).length === 0 && typeof input.threadId === 'string' && input.threadId.length > 0 && input.threadId.length <= 1024
      && input.includeNestedRows === 'false' && input.deferContent === 'true' && input.segmentLimit === '100' && keys.length === fields.length
      && keys.every((key, i) => key === fields[i] && Object.getOwnPropertyDescriptor(input, key)?.value === wire[key as keyof typeof wire]
        && typeof wire[key as keyof typeof wire] === 'string');
    const join = joinable ? { scope: options.scope, client, key: JSON.stringify({ deferContent: input.deferContent,
      includeNestedRows: input.includeNestedRows, segmentLimit: input.segmentLimit, threadId: input.threadId }), current: options.current } : undefined;
    return readScope(input.threadId, signal, bounded => client.timeline({ ...input, signal: bounded }), false,
      options.speculative ?? false, true, join, options.dispatched);
  }
  function complete(threadId: string) {
    running--; runningThreads.delete(threadId); speculativeThreads.delete(threadId); drainedWork(); schedule();
  }
  const visibility = () => {
    visible = !document.hidden;
    if (!visible) for (const read of historyReads) read.cancel(); else schedule();
  };
  document.addEventListener('visibilitychange', visibility);
  return { readScope, readTimeline, enqueue, unqueue, schedule, complete, queue, runningThreads, speculativeThreads, retainedCalls, historyReads,
    get running() { return running; }, isActive: () => active,
    attachTurnStarter(start: (entry: GalleryTurnWork) => void) {
      if (!active || startTurn) throw Error('Gallery work owner already attached or retired.');
      startTurn = start; schedule();
    },
    dispose() {
      if (!active) return; active = false; document.removeEventListener('visibilitychange', visibility);
      for (const read of historyReads) read.cancel(); queue.clear();
    },
    async whenDrained() { if (running) await (workDrain ??= new Promise<void>(resolve => { finishWorkDrain = resolve; })); },
  };
}
export type GalleryWorkOwner = ReturnType<typeof createGalleryWorkOwner>;
