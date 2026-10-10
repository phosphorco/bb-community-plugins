/** Full upstream JSON is retained until the BB presentation boundary. */
export type JsonObject = Record<string, unknown>;
export type Source = "official" | "mirror";
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
export interface MirrorConfig {
  binaryPath: string;
  token: string;
  cacheGeneration?: string;
  intervalSeconds?: number;
}
export interface MirrorManager {
  peer(signal?: AbortSignal): Promise<McpPeer>;
  configure(config: MirrorConfig): Promise<void>;
  status(): ConnectionStatus;
  /** Capture old versions and persist dirtiness before a possible official write. */
  markDirty(file?: string): Promise<void>;
  beginWrite(file?: string): Promise<string>;
  endWrite(ticket: string, outcome: "completed" | "uncertain"): Promise<void>;
  refresh(file?: string, signal?: AbortSignal, acceptUnverified?: boolean): Promise<JsonObject>;
  restart(): Promise<void>;
  close(): Promise<void>;
}
export interface MirrorOptions {
  directory: string;
  config: MirrorConfig;
  onChange?: () => void;
  requestTimeoutMs?: number;
}
export interface SettingsSnapshot {
  scope: "shared";
  config: {
    binaryPath: string;
    mirrorEnabled: boolean;
    binaryAvailable: boolean;
    tokenConfigured: boolean;
    clientId: string;
    clientSecretConfigured: boolean;
    redirectUri: string;
  };
  official: ConnectionStatus;
  mirror: ConnectionStatus;
  tools: Record<Source, McpTool[]>;
  aliasesNeedReload: boolean;
}
