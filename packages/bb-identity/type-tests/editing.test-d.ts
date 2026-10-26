import type { Codec, Result } from '../model.js';
import type { StateOutcome, IdentityState } from '../state.js';
import type { EditingDraft, EditingReceipt, EditingState, EditingBindingOptions, IdentityEditingBinding } from '../editing.js';
import { createIdentityEditingState, bindIdentityEditingState, editingCodecs } from '../editing-runtime.js';
import { useIdentityEditingBinding, useIdentityEditingSnapshot } from '../react-entry-runtime.js';
declare const codec: Codec<string>;
declare const options: Parameters<typeof createIdentityEditingState<string, { mapId: string }>>[0];
const state: EditingState<string, { mapId: string }> = createIdentityEditingState(options);
// @ts-expect-error opt-in snapshots cannot be smuggled into a legacy fixed binding.
const legacy: IdentityState<string> = state;
declare const bindingOptions: EditingBindingOptions<string, { mapId: string }>;
const binding: IdentityEditingBinding<string, { mapId: string }> = bindIdentityEditingState(bindingOptions);
const hook = useIdentityEditingBinding(bindingOptions);
const snapshot = useIdentityEditingSnapshot(hook);
if (snapshot.status !== 'waiting-for-identity') {
  const target: string = snapshot.scope.target.mapId;
  const text: string | undefined = snapshot.desired;
  void target; void text;
}
declare const rejected: Extract<EditingReceipt<string, string>['outcome'], { status: 'rejected' }>;
// @ts-expect-error definitive rejection is never a legacy StateOutcome.
const oldOutcome: StateOutcome<string> = rejected;
const codecs = editingCodecs(codec, codec);
declare const draft: EditingDraft<string, string>;
const decoded: Result<EditingDraft<string, string>> = codecs.draft.decode(codecs.draft.encode(draft));
void binding; void legacy; void oldOutcome; void decoded;

declare const scope: import('../editing.js').EditingScope<string>;
const scopeDecoded: Result<import('../editing.js').EditingScope<string>> = codecs.scope.decode(codecs.scope.encode(scope));
// @ts-expect-error a shared publication target cannot replace the actual actor-owned draft address.
const missingDraftOwner: import('../editing.js').EditingScope<string> = { target: 'shared-map' };
void scopeDecoded; void missingDraftOwner;
