/** Public candidate entry: raw scopes and adapter discovery remain inside the portable binding. */
import type { Result, Scheduler } from './model.js';
import { createBbIdentityServerBinding } from './bb-binding-runtime.js';
import type { BbIdentityApi, BbIdentityBinding } from './bb.js';
import type { ExternalMessageRendering } from './bb-upstream-runtime.js';

export function bindBbIdentity(
  bb: BbIdentityApi,
  options?: { readonly stateNamespace?: string; readonly scheduler?: Scheduler; readonly externalMessageRendering?: ExternalMessageRendering },
): Result<BbIdentityBinding> {
  return createBbIdentityServerBinding({
    bb,
    ...(options?.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
    ...(options?.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options?.externalMessageRendering === undefined ? {} : { externalMessageRendering: options.externalMessageRendering }),
  });
}
