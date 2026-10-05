// The wire fake's handler map and realtime feed fit SDK testing/app renderSlot options;
// the storage suite accepts a feature-owned AtomicStateStorage.
import type { RenderSlotOptions } from '@get-bb/plugin-sdk/testing/app';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createIdentityWireFake, defineStateStorageConformance, type IdentityWireFake } from '../testing.js';
import type { AtomicStateStorage, StateAddress, StateResource } from '../state.js';

declare const resource: StateResource<string>;
const fake: IdentityWireFake<string> = createIdentityWireFake({ host: createFakePluginHost({ pluginId: 'feature' }), mode: 'multi-user', resource, policy: { kind: 'collaborators' } });
const options: RenderSlotOptions = { rpc: fake.rpc, pluginId: 'feature' };
declare const emitRealtime: (channel: string, payload: unknown) => Promise<void>;
const stop: () => void = fake.onRealtime((channel, payload) => { void emitRealtime(channel, payload); });
void options; stop();

declare const storage: AtomicStateStorage<string>;
declare const address: (recordId: string) => StateAddress;
declare const test: { (name: string, fn: () => Promise<void>): unknown; skip(name: string, fn: () => Promise<void>): unknown };
defineStateStorageConformance({ test, open: () => ({ storage }), address, values: ['a', 'b'], skip: { restart: 'in-memory' } });
