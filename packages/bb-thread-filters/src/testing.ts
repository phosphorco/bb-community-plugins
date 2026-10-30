import { createThreadFilterClient } from './bb.js';
import type { MatchInput, ValuesInput, AttributeCell } from './index.js';
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
/** The same real registration must expose filters and values with matching IDs. */
export async function checkThreadAttributeSupplier(options:{transport:Parameters<typeof createThreadFilterClient>[0];pluginId:string;cases:readonly {input:ValuesInput;expected:readonly (readonly AttributeCell[])[]}[]}){
  const client=createThreadFilterClient(options.transport,options.pluginId),description=await client.describeAttributes();
  if(!description.values)throw Error('Supplier did not advertise attribute values.');
  for(const witness of options.cases){
    for(const id of witness.input.dimensionIds)if(!description.dimensions.some(d=>d.id===id))throw Error('Value attribute is not registered as a filter.');
    const output=await client.values(witness.input);
    const canonical=(cells:readonly AttributeCell[]|undefined)=>witness.input.dimensionIds.map(id=>{const cell=cells?.find(c=>c.dimensionId===id);return cell?{dimensionId:id,state:cell.state,message:cell.message,values:cell.values.map(({id,label})=>({id,label}))}:null;});
    if(JSON.stringify(witness.input.threads.map(t=>canonical(output.rows.find(r=>r.threadId===t.id)?.cells)))!==JSON.stringify(witness.expected.map(canonical)))throw Error('Attribute supplier conformance mismatch.');
  }
  return {proof:'source-conformance' as const,dimensions:description.dimensions.length,cases:options.cases.length};
}
