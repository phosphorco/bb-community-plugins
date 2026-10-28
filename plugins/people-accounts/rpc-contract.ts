import { defineRpcContract } from '@get-bb/plugin-sdk';
import { rosterRowV1Schema, personKeySchema } from '@phosphorco/bb-people-accounts';
import { z } from 'zod';

export const STATUS_CHANNEL = 'people-accounts/status';
export const statusSchema = z.object({
  entries: z.array(rosterRowV1Schema.extend({
    ownToken: z.object({ state: z.enum(['missing', 'configured', 'unreadable', 'invalid-format']), message: z.string().nullable() }),
    effectiveTokenSupplier: z.object({ personKey: personKeySchema, displayName: z.string() }).nullable(),
  })), diagnostics: z.array(z.string()), reloadRequired: z.boolean(),
});
export type PeopleStatus = z.infer<typeof statusSchema>;
export const localContract = defineRpcContract({
  peopleAccountsStatus: { input: z.null(), output: statusSchema },
  peopleAccountsCheck: { input: z.object({ personKeys: z.array(personKeySchema).max(16) }).strict(), output: statusSchema },
  peopleAccountsDirectory: {
    input: z.object({ query: z.string().max(320) }).strict(),
    output: z.object({ items: z.array(z.object({ personKey: z.string(), displayName: z.string(), handle: z.string().nullable() })), reason: z.string().nullable(), truncated: z.boolean() }),
  },
});
