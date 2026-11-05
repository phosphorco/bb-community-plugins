import { z } from 'zod';
export const PROTOCOL = 'bb.thread-filters';
export const METHODS = Object.freeze({ describe: 'threadFiltersDescribe', choices: 'threadFiltersChoicesV1', match: 'threadFiltersMatchV1', values: 'threadFiltersValuesV1' });
export const LIMITS = Object.freeze({ dimensions: 16, choices: 100, values: 16, threads: 200, inputBytes: 65536, outputBytes: 262144, describeBytes: 16384, callMs: 5000, concurrency: 4, plugins: 256 });
const id = z.string().min(1).max(4096);
const dimensionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const label = z.string().min(1).max(512);
export const dimensionSchema = z.object({ id: dimensionId, label, multiple: z.boolean(), description: z.string().max(1000) }).passthrough();
export const describeEnvelopeSchema = z.object({ protocol: z.literal(PROTOCOL), versions: z.array(z.number().int().positive()).max(16) }).passthrough();
export const describeSchema = describeEnvelopeSchema.extend({ dimensions: z.array(dimensionSchema).max(LIMITS.dimensions), valueVersions: z.array(z.number().int().positive()).max(16).optional() });
export const choicesInputSchema = z.object({ dimensionId, viewerKey: id, query: z.string().max(256), cursor: z.string().max(4096).nullable(), limit: z.number().int().min(1).max(LIMITS.choices) }).strict();
export const choiceSchema = z.object({ id, label }).passthrough();
export const choicesOutputSchema = z.object({ choices: z.array(choiceSchema).max(LIMITS.choices), nextCursor: id.nullable(), revision: z.string().max(256) }).passthrough();
export const selectionSchema = z.object({ dimensionId, values: z.array(id).min(1).max(LIMITS.values), mode: z.enum(['any', 'all']) }).strict();
export const threadSchema = z.object({ id: z.string().min(1).max(256), projectId: z.string().min(1).max(256), parentThreadId: z.string().max(256).nullable() }).strict();
export const matchInputSchema = z.object({ viewerKey: id, selection: selectionSchema, threads: z.array(threadSchema).min(1).max(LIMITS.threads) }).strict();
export const matchOutputSchema = z.object({ rows: z.array(z.object({ threadId: z.string().min(1).max(256), matches: z.boolean().nullable() }).passthrough()).max(LIMITS.threads), revision: z.string().max(256), coverage: z.enum(['complete', 'partial', 'unknown']), message: z.string().max(1000).nullable(), refreshAt: z.number().finite().nullable() }).passthrough();
export type Dimension = z.infer<typeof dimensionSchema>;
export type Choice = z.infer<typeof choiceSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type ChoicesInput = z.infer<typeof choicesInputSchema>;
export type ChoicesOutput = z.infer<typeof choicesOutputSchema>;
export type MatchInput = z.infer<typeof matchInputSchema>;
export type MatchOutput = z.infer<typeof matchOutputSchema>;
export const valuesInputSchema = z.object({viewerKey:id,dimensionIds:z.array(dimensionId).min(1).max(LIMITS.dimensions),threads:z.array(threadSchema).min(1).max(LIMITS.threads)}).strict();
export const attributeCellSchema = z.object({dimensionId,values:z.array(choiceSchema).max(LIMITS.values),state:z.enum(['known','partial','unknown','not-applicable']),message:z.string().max(1000).nullable()}).passthrough();
export const valuesOutputSchema = z.object({rows:z.array(z.object({threadId:z.string().min(1).max(256),cells:z.array(attributeCellSchema).max(LIMITS.dimensions)}).passthrough()).max(LIMITS.threads),revision:z.string().max(256),refreshAt:z.number().finite().nullable()}).passthrough();
export type AttributeCell = z.infer<typeof attributeCellSchema>;
export type ValuesInput = z.infer<typeof valuesInputSchema>;
export type ValuesOutput = z.infer<typeof valuesOutputSchema>;
export type FilterSelection = Selection & { pluginId: string; label: string; valueLabels: string[] };
export function matchValues(actual: readonly string[], selected: readonly string[], mode: 'any' | 'all'): boolean {
  return mode === 'all' ? selected.every(value => actual.includes(value)) : selected.some(value => actual.includes(value));
}
export function validateMatch(input: MatchInput, raw: unknown): MatchOutput {
  const result = matchOutputSchema.parse(raw), requested = new Set(input.threads.map(thread => thread.id)), seen = new Set<string>();
  if (requested.size !== input.threads.length) throw Error('Duplicate requested threads.');
  for (const row of result.rows) {
    if (!requested.has(row.threadId) || seen.has(row.threadId)) throw Error('Unexpected or duplicate match row.');
    seen.add(row.threadId);
  }
  if (seen.size !== requested.size) throw Error('Missing match rows.');
  if (result.coverage === 'complete' && result.rows.some(row => row.matches === null)) throw Error('Complete results cannot contain unknown matches.');
  return result;
}
export function validateValuesInput(input: ValuesInput): ValuesInput {
  if(new Set(input.dimensionIds).size!==input.dimensionIds.length || new Set(input.threads.map(t=>t.id)).size!==input.threads.length) throw Error('Duplicate requested attributes or threads.');
  return input;
}
export function validateValues(input: ValuesInput, raw: unknown): ValuesOutput {
  validateValuesInput(input);
  const result=valuesOutputSchema.parse(raw),requested=new Set(input.threads.map(t=>t.id)),seen=new Set<string>();
  for(const row of result.rows){
    if(!requested.has(row.threadId)||seen.has(row.threadId))throw Error('Unexpected or duplicate attribute row.');
    seen.add(row.threadId);const dimensions=new Set<string>();
    for(const cell of row.cells){
      if(!input.dimensionIds.includes(cell.dimensionId)||dimensions.has(cell.dimensionId))throw Error('Unexpected or duplicate attribute cell.');
      dimensions.add(cell.dimensionId);
      if(new Set(cell.values.map(v=>v.id)).size!==cell.values.length)throw Error('Duplicate attribute values.');
      if((cell.state==='unknown'||cell.state==='not-applicable')&&cell.values.length)throw Error('Unresolved or inapplicable cells cannot claim values.');
    }
    if(dimensions.size!==input.dimensionIds.length)throw Error('Missing attribute cells.');
  }
  if(seen.size!==requested.size)throw Error('Missing attribute rows.');
  return result;
}
/** Preserve a bounded positive prefix without turning omitted values into None. */
export function boundAttributeValues(output:ValuesOutput):ValuesOutput {
  const encoder=new TextEncoder(),size=(value:unknown)=>encoder.encode(JSON.stringify(value)).length;
  if(size(output)<=LIMITS.outputBytes)return output;
  const result:ValuesOutput={...output,rows:output.rows.map(row=>({...row,cells:row.cells.map(cell=>({...cell,values:[],state:cell.values.length?'unknown':cell.state,message:cell.values.length?[cell.message,'Some values are omitted by the response limit.'].filter(Boolean).join(' '):cell.message}))}))};
  let used=size(result);if(used>LIMITS.outputBytes)throw Error('Attribute metadata exceeds byte limit.');
  for(let r=0;r<output.rows.length;r++)for(let c=0;c<output.rows[r]!.cells.length;c++){
    const original=output.rows[r]!.cells[c]!,cell=result.rows[r]!.cells[c]!;
    for(const value of original.values){const bytes=size(value)+(cell.values.length?1:0);if(used+bytes>LIMITS.outputBytes)break;cell.values.push(value);used+=bytes;}
    if(cell.values.length===original.values.length){cell.state=original.state;cell.message=original.message;}
    else cell.state=cell.values.length?'partial':'unknown';
  }
  return result;
}
/** Validate the already parsed JSON before a stripping DTO decoder. No raw transport allocation bound is claimed. */
export function parseBounded<T>(schema: z.ZodType<T>, raw: unknown, bytes: number): T {
  const encoded = JSON.stringify(raw);
  if (encoded === undefined || new TextEncoder().encode(encoded).length > bytes) throw Error('Thread filter response exceeds byte limit.');
  return schema.parse(raw);
}
