/** Compatible native facade; every borrowed export is the shared core export. */
export * from './react-core-entry-runtime.js';
import { BbIdentityReact } from './react-native-runtime.js';
import type { useBbIdentityClient as UseBbIdentityClient, useBbIdentityConnection as UseBbIdentityConnection } from './react.js';
export const useBbIdentityConnection: typeof UseBbIdentityConnection = () => BbIdentityReact.useNativeIdentityConnection();
export const useBbIdentityClient: typeof UseBbIdentityClient = () => BbIdentityReact.useNativeIdentityClient();
