import { addUsageVectors, zeroUsageVector } from './vector.js';
import type { UsageVector } from './vector.js';
export const BUCKET_MS = 5 * 60 * 1000;
export const WINDOW_MS = {m20: 20 * 60 * 1000, h24: 24 * 60 * 60 * 1000, d7: 7 * 24 * 60 * 60 * 1000} as const;
function time(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('time must be nonnegative safe integer milliseconds'); }
export function bucketStart(timestamp: number): number { time(timestamp); return Math.floor(timestamp / BUCKET_MS) * BUCKET_MS; }
export interface UsageBucket { start: number; vector: UsageVector }
/** Last ceil(duration / BUCKET_MS) buckets including current; excludes future buckets.
 * Fixed windows can under-cover the boundary by less than five minutes. */
export function windowSum(buckets: readonly UsageBucket[], now: number, duration: number): UsageVector {
  time(now); time(duration);
  if (duration === 0) return zeroUsageVector();
  const upper = bucketStart(now);
  const count = Math.ceil(duration / BUCKET_MS);
  const lower = Math.max(0, upper - (count - 1) * BUCKET_MS);
  let result = zeroUsageVector();
  for (const bucket of buckets) {
    if (bucketStart(bucket.start) !== bucket.start) throw new RangeError('unaligned bucket');
    if (bucket.start >= lower && bucket.start <= upper) result = addUsageVectors(result, bucket.vector);
  }
  return result;
}
