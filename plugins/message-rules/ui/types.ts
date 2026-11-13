import type {
  Rule,
  RuleGroup,
  Connection,
  FileLocation,
} from "../contracts/model.ts";
import type { Occurrence, Run } from "../state/store.ts";
export type ProjectState = {
  id: string;
  revision: number;
  config: {
    hostId: string;
    root: string;
    connection: Connection;
    locationRevision?: number;
  };
  groups: RuleGroup[];
  rules: Rule[];
  occurrences: Occurrence[];
};
export type Snapshot = {
  catalog?: import("../contracts/catalog.ts").CatalogInfo;
  project: ProjectState | null;
  basis: string | null;
  run: Run | null;
  acknowledgedRun?: Run;
  savedOccurrenceId?: string;
  readError: string | null;
  connection: { configured: boolean; tokenAccounting: boolean; mode: string; source?:string;ownerPluginId?:string;reason?:string };
  delivery: { state: string; reason: string; activeKnown?: boolean; generationReady?: boolean; activePolicy?: { ref:{policyId:string;fingerprint:string};projectId:string;enabled:boolean;createdAt:string;catalogRevision:number } | null; recentSenderDecisions?: {created_at:string;thread_id:string;sender_thread_id:string|null;policy_id:string;decision:unknown}[] };
  unresolved: unknown[];
};
export type Client = {
  call(method: string, input: unknown): Promise<Snapshot>;
  listRecentDecisions(input: import("../admission/decisions-contract.ts").RecentDecisionsInput): Promise<import("../admission/decisions-contract.ts").RecentDecisions>;
};
export type Draft = {
  value: string;
  base: string;
  hash: string | null;
  kind: "rule" | "test" | "group";
  enabled: boolean;
  conflict?: string;
  location?: FileLocation;
  pending?: import("./writes.ts").PendingSave;
};

export type LookupState = {
  status: "loading" | "ready" | "error";
  message?: string;
};
