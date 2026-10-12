/** Full upstream JSON is retained until the BB presentation boundary. */
export type JsonObject = Record<string, unknown>;
export type Source = "official";
export interface McpTool extends JsonObject {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
}
export interface McpInfo {
  capabilities: JsonObject;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}
export interface McpPeer {
  request(method: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  info(): McpInfo;
  onCatalogChanged?(listener: () => void): () => void;
  close(): Promise<void>;
}
export type ConnectionPhase = "unconfigured" | "disconnected" | "connecting" | "authorizing" | "connected" | "error";
export interface ConnectionStatus {
  phase: ConnectionPhase;
  detail: string | null;
  connectedAt: number | null;
  serverVersion: string | null;
}
export interface SecretStore {
  read(): Promise<JsonObject | null>;
  write(value: JsonObject | null): Promise<void>;
}
export interface OfficialConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface RemoteManager {
  /** Restore only the saved authorization state; never opens a connection. */
  restoreStatus?(): Promise<void>;
  peer(signal?: AbortSignal): Promise<McpPeer>;
  beginAuth(): Promise<{ authorizationUrl: string }>;
  finishAuth(input: { code: string; state: string; issuer?: string }): Promise<void>;
  status(): ConnectionStatus;
  disconnect(): Promise<void>;
  close(): Promise<void>;
}
export interface RemoteOptions {
  store: SecretStore;
  config: () => Promise<OfficialConfig>;
  onChange?: () => void;
  fetch?: typeof fetch;
}
export interface SettingsSnapshot {
  scope: "shared";
  config: { clientId: string; clientSecretConfigured: boolean; redirectUri: string };
  official: ConnectionStatus;
  tools: { official: McpTool[] };
  aliasesNeedReload: boolean;
}
