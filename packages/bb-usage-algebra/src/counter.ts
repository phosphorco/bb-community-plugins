import { z } from 'zod';
import { UsageVectorSchema, USAGE_CLASSES, zeroUsageVector } from './vector.js';
import type { UsageVector } from './vector.js';
export const CounterSnapshotSchema = z.object({ epochKey: z.string().min(1).max(1024), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), total: UsageVectorSchema });
export type CounterSnapshot = z.infer<typeof CounterSnapshotSchema>;
export interface CounterIncrement { state: CounterSnapshot; increment: UsageVector; status: 'initial' | 'advance' | 'duplicate' | 'stale' | 'epoch-change' | 'regression-reset' }
/** Caller supplies a globally ordered sequence per stream, even across epochs. */
export function counterToIncrement(previous: CounterSnapshot | null, snapshot: CounterSnapshot): CounterIncrement {
  const next = CounterSnapshotSchema.parse(snapshot);
  if (!previous) return {state: next, increment: next.total, status: 'initial'};
  const prev = CounterSnapshotSchema.parse(previous);
  if (next.sequence <= prev.sequence) return {state: prev, increment: zeroUsageVector(), status: next.sequence === prev.sequence ? 'duplicate' : 'stale'};
  if (next.epochKey !== prev.epochKey) return {state: next, increment: next.total, status: 'epoch-change'};
  if (USAGE_CLASSES.some(k => next.total[k] < prev.total[k]))
    return {state: next, increment: next.total, status: 'regression-reset'};
  const increment = zeroUsageVector();
  for (const key of USAGE_CLASSES) increment[key] = next.total[key] - prev.total[key];
  return {state: next, increment, status: 'advance'};
}
export function counterToIncrements(snapshots: readonly CounterSnapshot[], previous: CounterSnapshot | null = null): CounterIncrement[] {
  let state = previous;
  return snapshots.map(snapshot => { const result = counterToIncrement(state, snapshot); state = result.state; return result; });
}
