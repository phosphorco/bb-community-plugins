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
  connection: { configured: boolean; tokenAccounting: boolean; mode: string };
  delivery: { state: string; reason: string };
  unresolved: unknown[];
};
export type Client = {
  call(method: string, input: unknown): Promise<Snapshot>;
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
