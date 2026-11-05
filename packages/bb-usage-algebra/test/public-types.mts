import { UsageVectorSchema, type UsageVector } from '../dist/types/vector.js';
import { canonicalize, counterToIncrement, price, DEFAULT_RATE_TABLE, type CounterSnapshot } from '../dist/types/index.js';
const vector: UsageVector = UsageVectorSchema.parse({inputUncached:1, cacheRead:0,cacheWrite:0,output:2});
const snapshot: CounterSnapshot = {epochKey:'session',sequence:1,total:vector};
const amount: number | null = price(DEFAULT_RATE_TABLE,'codex','gpt-6.1-sol',counterToIncrement(null,snapshot).increment).amount;
canonicalize('pi',{inputTokens:1,outputTokens:2});
void amount;
// @ts-expect-error disjoint vectors require every class
const invalid: UsageVector = {output:1};
void invalid;
