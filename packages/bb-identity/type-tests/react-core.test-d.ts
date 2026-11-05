import * as core from '../react-core.js';
import * as native from '../react.js';
import type { ComponentProps } from 'react';
import type { IdentityClient } from '../client.js';
const sameProvider: typeof native.BbIdentity.Provider = core.BbIdentity.Provider;
const sameContext: typeof core.BbIdentity.Context = native.BbIdentity.Context;
const samePicker: typeof native.IdentityViewPicker = core.IdentityViewPicker;
const sameStateHook: typeof native.useIdentityStateBinding = core.useIdentityStateBinding;
const sameEditingHook: typeof native.useIdentityEditingBinding = core.useIdentityEditingBinding;
declare const client: IdentityClient;
const props: ComponentProps<typeof core.BbIdentity.Provider> = { client };
void [sameProvider,sameContext,samePicker,sameStateHook,sameEditingHook,props];
// @ts-expect-error owner-bound hosted code cannot acquire the current SDK slot
core.useBbIdentityClient;
