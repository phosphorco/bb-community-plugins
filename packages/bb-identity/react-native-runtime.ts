/** Native slot-hook acquisition; borrowed core never imports this module. */
import * as React from 'react';
import { useRealtime, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { PluginRpcClient, PluginRealtimeConnectionState, StandardSchemaV1 } from '@get-bb/plugin-sdk/app';
import type { IdentityClient, IdentityConnection } from './client.js';
import { createNativeIdentityConnection, nativeIdentityRealtimeChannel } from './bb-client-connection-runtime.js';
import { createIdentityClient } from './client-runtime.js';
import { identityRpcMethods } from './rpc-routes-runtime.js';
import { BbIdentityReactCore, createIdentityReactCoreRuntime, useCommittedResource } from './react-core-runtime.js';
import type { IdentityReactCoreRuntime } from './react-core-runtime.js';

type NativeMethod = (typeof identityRpcMethods)[keyof typeof identityRpcMethods];
type NativeContract = {
  readonly [Method in NativeMethod]: {
    readonly input: StandardSchemaV1<unknown, unknown>;
    readonly output: StandardSchemaV1<unknown, unknown>;
  };
};

/** Only public SDK hooks are injectable; React itself is always the real React runtime. */
export interface NativeIdentityReactHooks {
  useRpc(): PluginRpcClient<NativeContract>;
  useRealtime(channel: string, handler: (payload: unknown) => void): void;
  useRealtimeConnectionState(): PluginRealtimeConnectionState;
}

export interface IdentityReactRuntime extends IdentityReactCoreRuntime {
  useNativeIdentityConnection(): IdentityConnection | null;
  useNativeIdentityClient(): IdentityClient | null;
}

function withNativeAcquisition(native: NativeIdentityReactHooks, core: IdentityReactCoreRuntime): IdentityReactRuntime {
  const useNativeIdentityConnection = (): IdentityConnection | null => {
    const rpc = native.useRpc();
    const realtimeState = native.useRealtimeConnectionState();
    const adapter = useCommittedResource(rpc, () => createNativeIdentityConnection({ rpc, realtimeState }), value => value.dispose());
    const receive = React.useCallback((payload: unknown) => { adapter?.acceptRealtime(payload); }, [adapter]);
    native.useRealtime(nativeIdentityRealtimeChannel, receive);
    React.useEffect(() => { adapter?.setRealtimeState(realtimeState); }, [adapter, realtimeState]);
    return adapter?.connection ?? null;
  };

  const useNativeIdentityClient = (): IdentityClient | null => {
    const connection = useNativeIdentityConnection();
    const client = useCommittedResource(connection, () => connection === null ? null : createIdentityClient({ connection }), value => value?.dispose());
    React.useEffect(() => { if (client !== null) void client.start(); }, [client]);
    return client;
  };

  return { ...core, useNativeIdentityConnection, useNativeIdentityClient };
}

/** Preserves the existing internal injected-test factory's independent lifetime. */
export function createIdentityReactRuntime(native: NativeIdentityReactHooks): IdentityReactRuntime {
  return withNativeAcquisition(native, createIdentityReactCoreRuntime());
}

/** Public native composition borrows the SAME core used by /react-core. */
export const BbIdentityReact = withNativeAcquisition({
  useRpc: () => useRpc<NativeContract>(),
  useRealtime,
  useRealtimeConnectionState,
}, BbIdentityReactCore);
