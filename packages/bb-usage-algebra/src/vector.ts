import { z } from 'zod';

/** Disjoint billable classes. Reasoning is already included in output. */
export const UsageVectorSchema = z.object({
  inputUncached: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(),
  cacheWrite: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
});
export type UsageVector = z.infer<typeof UsageVectorSchema>;
export const USAGE_CLASSES = ['inputUncached', 'cacheRead', 'cacheWrite', 'output'] as const;
export function zeroUsageVector(): UsageVector {
  return { inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}
export function addUsageVectors(...vectors: readonly UsageVector[]): UsageVector {
  const result = zeroUsageVector();
  for (const vector of vectors) {
    UsageVectorSchema.parse(vector);
    for (const key of USAGE_CLASSES) result[key] += vector[key];
  }
  return UsageVectorSchema.parse(result); // Reject arithmetic overflow too.
}
