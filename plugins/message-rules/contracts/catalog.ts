// A catalog address, never a BB project identity.
export const GLOBAL_CATALOG = "message-rules-global";
export type CatalogInfo = {
  aliases: {
    projectId: string;
    kind: "group" | "rule" | "test";
    oldId: string;
    id: string;
  }[];
  sources: { projectId: string; defaultGroupId: string | null }[];
  notes: string[];
};
