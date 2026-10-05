/** Source-only server RPC foundation; full BbIdentityBinding remains unpublished. */
import type { BbPluginApi, PluginRpcContract, PluginRpcHandlers, StandardSchemaV1InferInput, StandardSchemaV1InferOutput } from '@get-bb/plugin-sdk';
import type { ForkIdentityExtensionSurface, ForkInvocationContext, ForkInvocationRegistration } from './host.js';
import { inspectForkExtension } from './host-runtime.js';
import type { Disposable, Result } from './model.js';
import { err, ok } from './model-runtime.js';

type IdentityHandlers<C extends PluginRpcContract> = {
  readonly [M in keyof C]: {
    readonly origin: 'interactive-user' | 'background' | 'external';
    readonly handle: (input: StandardSchemaV1InferOutput<C[M]['input']>, context: ForkInvocationContext<unknown>) =>
      StandardSchemaV1InferInput<C[M]['output']> | Promise<StandardSchemaV1InferInput<C[M]['output']>>;
  };
};
/** Minimal private context shared by enhanced and upstream RPC wrappers. */
export interface BbPortableInvocation {
  readonly request: unknown;
  readonly signal: AbortSignal;
  readonly origin: 'interactive-user' | 'background' | 'external';
}
export type BbPortableIdentityHandlers<C extends PluginRpcContract> = {
  readonly [M in keyof C]: {
    readonly origin: BbPortableInvocation['origin'];
    readonly handle: (input: StandardSchemaV1InferOutput<C[M]['input']>, context: BbPortableInvocation) =>
      StandardSchemaV1InferInput<C[M]['output']> | Promise<StandardSchemaV1InferInput<C[M]['output']>>;
  };
};
/** Internal shape used by state and portable composition, not a published binding API. */
export interface BbPortableRpcFoundation extends Disposable {
  readonly instanceId: string;
  register<C extends PluginRpcContract>(contract: C, handlers: BbPortableIdentityHandlers<C>): Result<void>;
}
export interface BbIdentityRpcFoundation extends Disposable {
  readonly instanceId: string;
  register<C extends PluginRpcContract>(contract: C, handlers: IdentityHandlers<C>): Result<void>;
}
export function bindBbIdentityRpcFoundation(bb: Pick<BbPluginApi, 'rpc' | 'onDispose'> & ForkIdentityExtensionSurface): Result<BbIdentityRpcFoundation> {
  const extension = inspectForkExtension<unknown, unknown, unknown>(bb.experimental_p6rIdentity);
  if (extension.status === 'absent') return err('unsupported', 'Native identity RPC foundation requires experimental_p6rIdentity.');
  if (extension.status === 'malformed') return { ok: false, error: extension.error };
  if (extension.status !== 'supported') return err('incompatible', 'The identity host protocol is incompatible.');
  let disposed = false;
  const registrations = new Set<ForkInvocationRegistration>();
  const retire = (handles: Iterable<ForkInvocationRegistration>) => {
    for (const handle of handles) { registrations.delete(handle); try { handle.dispose(); } catch {} }
  };
  const dispose = () => { if (disposed) return; disposed = true; retire([...registrations]); };
  const foundation: BbIdentityRpcFoundation = {
    instanceId: extension.protocol.instanceId,
    register<C extends PluginRpcContract>(contract: C, handlers: IdentityHandlers<C>): Result<void> {
      if (disposed) return err('disposed', 'Identity RPC foundation is disposed.');
      const methods = Object.keys(contract);
      if (methods.length !== Object.keys(handlers).length || methods.some(method => {
        if (!Object.hasOwn(handlers, method)) return true;
        const descriptor = handlers[method];
        return !descriptor || typeof descriptor.handle !== 'function' || !['interactive-user', 'background', 'external'].includes(descriptor.origin);
      })) return err('invalid-input', 'RPC handlers must exactly match the contract and declare a valid origin.');
      const staged: ForkInvocationRegistration[] = [];
      let admitted = true;
      const bound: Partial<PluginRpcHandlers<C>> = {};
      const bindMethod = <M extends keyof C>(method: M) => {
        const descriptor = handlers[method];
        const invocation = extension.protocol.bindInvocation({
          routeClass: descriptor.origin === 'interactive-user' ? 'interactive-session' : descriptor.origin === 'external' ? 'external-credential' : 'plugin-background',
          handler: (context: ForkInvocationContext<unknown>, input: StandardSchemaV1InferOutput<C[M]['input']>) => {
            if (disposed || !admitted) throw new Error('Identity RPC registration is disposed.');
            return descriptor.handle(input, context);
          },
        });
        staged.push(invocation.registration);
        bound[method] = invocation.handler;
      };
      try {
        for (const method in contract) if (Object.hasOwn(contract, method)) bindMethod(method);
        // Every own contract key has a typed handler, after exact descriptor validation above.
        bb.rpc.register(contract, bound as PluginRpcHandlers<C>);
        if (disposed) { admitted = false; retire(staged); return err('disposed', 'Identity RPC foundation was disposed during registration.'); }
        for (const handle of staged) registrations.add(handle);
        return ok(undefined);
      } catch {
        admitted = false; retire(staged);
        return err('unavailable', 'Native identity RPC registration failed.', 'after-refresh');
      }
    },
    dispose,
  };
  try { bb.onDispose(dispose); } catch { dispose(); return err('unavailable', 'Plugin disposal registration failed.'); }
  return ok(foundation);
}
