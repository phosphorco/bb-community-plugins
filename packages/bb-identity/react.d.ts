/** Native SDK acquisition plus the exact shared borrowed-client React contract. */
export * from './react-core.js';
import type { IdentityClient, IdentityConnection } from './client.js';
/** Native SDK hook composition. Null means committed acquisition is still pending. */
export declare function useBbIdentityConnection(): IdentityConnection | null;
/** Native SDK hook composition. Null means the committed connection/client is not live yet. */
export declare function useBbIdentityClient(): IdentityClient | null;
