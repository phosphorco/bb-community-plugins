import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createImageObservationStore } from './store.ts';
import { createImageVerificationPorts, createImagePreviewPort } from './sdk-ports.ts';
import { registerImageResults } from './supplier.ts';

export default function imageResultsPlugin(bb: BbPluginApi): void {
  const store = createImageObservationStore(bb.storage.database());
  registerImageResults(bb, { store, verification: createImageVerificationPorts(bb.sdk),
    preview: createImagePreviewPort(bb.sdk), now: Date.now });
}
