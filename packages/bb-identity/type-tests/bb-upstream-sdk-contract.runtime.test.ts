/** Compile-only witness for the installed public SDK used by ordinary package checks. */
import type { BbPluginApi as InstalledBbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';

type InstalledSendArguments = Parameters<InstalledBbPluginApi['sdk']['threads']['send']>[0];
type InstalledSendResult = Awaited<ReturnType<InstalledBbPluginApi['sdk']['threads']['send']>>;
type InstalledRpcArguments = Parameters<InstalledBbPluginApi['sdk']['plugins']['callRpc']>[0];

/** Current SDK distinguishes an immediately sent message from a queued one. */
const installedRequest: InstalledSendArguments = {
  threadId: 'thread-sdk-witness',
  mode: 'auto',
  input: [{ type: 'text', text: 'Preserve native mentions.', mentions: [] }],
};
const installedResponse: InstalledSendResult = { ok: true, delivery: 'sent' };
const installedHasDelivery: 'delivery' extends keyof InstalledSendResult ? true : false = true;
/** Installed callRpc remains Zod-shaped; this stays an internal-only source constraint. */
const unknownOutputSchema = z.unknown();
const installedRpcCall: InstalledRpcArguments = {
  pluginId: 'identity-destination', method: 'identity.lookup', input: { address: 'self' }, outputSchema: unknownOutputSchema,
};

void installedRequest;
void installedResponse;
void installedHasDelivery;
void installedRpcCall;
