import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {createdThreadClaimInput,createdThreadDescribeSchema,createdThreadClaimResultSchema,createdThreadLookupResultSchema} from '../inbox-assignment-contract';
// Identical static V1 evidence is deliberately shipped in both products. No provider source import.
const matrix=z.object({protocol:z.literal('inbox-created-thread-assignment'),version:z.literal(1),cases:z.array(z.object({name:z.string(),kind:z.enum(['request','describe','claim','lookup']),accepted:z.boolean(),data:z.unknown()}))}).parse(JSON.parse(readFileSync(new URL('./fixtures/created-thread-assignment-v1.json',import.meta.url),'utf8')));
const schemas={request:createdThreadClaimInput,describe:createdThreadDescribeSchema,claim:createdThreadClaimResultSchema,lookup:createdThreadLookupResultSchema};
for(const example of matrix.cases)test('consumer public V1 wire: '+example.name,()=>{expect(schemas[example.kind].safeParse(example.data).success).toBe(example.accepted);});
