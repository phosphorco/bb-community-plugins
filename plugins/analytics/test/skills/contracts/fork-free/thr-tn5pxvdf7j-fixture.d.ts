/** Public fixture shared by the fork-free contract and projection probes. */
declare module "*thr-tn5pxvdf7j.mjs" {
  export const catalogSnapshot: import("../../../../skill-observation-contract.ts").PublicSkillCatalogSnapshot;
  export const activeCapture: import("../../../../skill-observation-contract.ts").PublicSkillCatalogCapture;
  export const probeEvents: readonly import("../../../../skill-observation-contract.ts").PublicThreadEvent[];
}
