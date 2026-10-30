import { createThreadFilterClient } from './bb.js';
import type { MatchInput } from './index.js';
/** Drive actual registered handlers through the host harness; source conformance, not live proof. */
export async function checkThreadFilterSupplier(options: { transport: Parameters<typeof createThreadFilterClient>[0]; pluginId: string; cases: readonly { input: MatchInput; expected: readonly (boolean | null)[] }[] }) {
  const client = createThreadFilterClient(options.transport, options.pluginId);
  const dimensions = await client.describe();
  for (const witness of options.cases) {
    const output = await client.match(witness.input);
    if (JSON.stringify(witness.input.threads.map(t => output.rows.find(row => row.threadId === t.id)?.matches)) !== JSON.stringify(witness.expected)) throw Error('Filter supplier conformance mismatch.');
  }
  return { proof: 'source-conformance' as const, dimensions: dimensions.length, cases: options.cases.length };
}
